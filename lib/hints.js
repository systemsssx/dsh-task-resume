/**
 * dsh-hint-handoff — host half, hint part (merged from dsh-hint-ball 0.1.0).
 *
 * Owns the hint list and exposes it to the browser half (the 提示交接 dialog)
 * over the same same-origin routes the original plugin used:
 *
 *   GET  /hint/list?since=<ms>&limit=<n>  -> { ok, hints, unread, total, config }
 *   POST /hint/push   { title, body?, level?, source?, hints?: [...] }
 *   POST /hint/read   { ids?: [...], all?: true }
 *   POST /hint/clear  { onlyRead?: true }
 *   POST /hint/config { maxHints?, autoOpenOnError?, seedFile?, persistPath?, reset? }
 *
 * It also registers the `post_hint` agent tool, so the model itself can push a
 * hint into the panel. The Settings namespace is registered once by the merged
 * `lib/index.js` (single `hint-handoff` namespace), so this module deliberately
 * owns no `Config` export and no settings registration.
 *
 * Route registration contract (verified in the shipped plugins):
 * `ctx.inject(['webServer'], hostCtx => hostCtx.effect(
 * () => hostCtx.webServer.register({ kind:'exact', path, handler })))` and
 * `ctx.tools.register({ name, description, parameters, output, execute })`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  createHintStore,
  deserializeStore,
  parseSeed,
  serializeStore,
} from './hint-store.js'

/** Reported by `GET /hint/list` so a running host can be matched to the source. */
const HINT_PART_VERSION = '0.1.0'

const DEFAULTS = Object.freeze({
  enabled: true,
  maxHints: 50,
  pollMs: 4000,
  autoOpenOnError: false,
  seedFile: '',
  persistPath: '',
})

const SAVE_DEBOUNCE_MS = 250

function numberOr(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - boot-time config from `cordis.patch.yml`.
 */
export function registerHints(ctx, config = {}) {
  const boot = {
    enabled: boolOr(config.enabled, DEFAULTS.enabled),
    maxHints: numberOr(config.maxHints, DEFAULTS.maxHints, 1, 500),
    pollMs: numberOr(config.pollMs, DEFAULTS.pollMs, 1000, 60000),
    autoOpenOnError: boolOr(config.autoOpenOnError, DEFAULTS.autoOpenOnError),
    seedFile: stringOr(config.seedFile, DEFAULTS.seedFile),
    persistPath: stringOr(config.persistPath, DEFAULTS.persistPath),
  }

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-hint-handoff] ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  /** Resolve a service lazily: services may not be mounted when `apply` runs. */
  const service = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }

  const store = createHintStore({ maxHints: boot.maxHints })

  // -------------------------------------------------------------------------
  // Effective configuration
  //
  // Precedence: cordis.patch.yml (boot) < the `hint-handoff` settings namespace
  // (when the host settings service is mounted) < runtime overrides written
  // through `POST /hint/config`.
  //
  // The runtime layer exists because the browser half has no client-side
  // settings API in this build (`settingsScope` does not exist in 0.2.0-rc.2),
  // so Settings → Hint Ball edits are routed through the plugin's own HTTP
  // surface. It lives in the host process memory: it applies immediately and is
  // forgotten when the plugin is reloaded, which the settings section says out
  // loud.
  // -------------------------------------------------------------------------

  const CONFIG_KEYS = ['enabled', 'maxHints', 'pollMs', 'autoOpenOnError', 'seedFile', 'persistPath']

  /** @type {Record<string, unknown>} */
  let runtimeOverrides = {}

  function effectiveConfig() {
    const merged = { ...boot }
    let live = null
    const settings = service('settings')
    if (settings && typeof settings.get === 'function') {
      try {
        live = settings.get('hint-handoff')
      } catch {
        live = null
      }
    }
    if (live && typeof live === 'object') {
      merged.enabled = boolOr(live.enabled, merged.enabled)
      merged.maxHints = numberOr(live.maxHints, merged.maxHints, 1, 500)
      merged.pollMs = numberOr(live.pollMs, merged.pollMs, 1000, 60000)
      merged.autoOpenOnError = boolOr(live.autoOpenOnError, merged.autoOpenOnError)
      merged.seedFile = stringOr(live.seedFile, merged.seedFile)
      merged.persistPath = stringOr(live.persistPath, merged.persistPath)
    }
    for (const key of CONFIG_KEYS) {
      if (runtimeOverrides[key] !== undefined) merged[key] = runtimeOverrides[key]
    }
    // A live maxHints edit must trim the buffer without a reload.
    store.setMaxHints(merged.maxHints)
    return merged
  }

  /** Validate a `POST /hint/config` body down to the keys we accept. */
  function sanitizeConfigPatch(body) {
    const patch = {}
    if (!body || typeof body !== 'object') return patch
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (Number.isFinite(Number(body.maxHints))) patch.maxHints = numberOr(body.maxHints, boot.maxHints, 1, 500)
    if (Number.isFinite(Number(body.pollMs))) patch.pollMs = numberOr(body.pollMs, boot.pollMs, 1000, 60000)
    if (typeof body.autoOpenOnError === 'boolean') patch.autoOpenOnError = body.autoOpenOnError
    if (typeof body.seedFile === 'string') patch.seedFile = body.seedFile.trim()
    if (typeof body.persistPath === 'string') patch.persistPath = body.persistPath.trim()
    return patch
  }

  /** What the browser half is allowed to know about the config. */
  function publicConfig(cfg) {
    return {
      enabled: cfg.enabled,
      maxHints: cfg.maxHints,
      pollMs: cfg.pollMs,
      autoOpenOnError: cfg.autoOpenOnError,
      persistPath: cfg.persistPath,
      seedFile: cfg.seedFile,
    }
  }

  // -------------------------------------------------------------------------
  // Seed file + JSON persistence (both opt-in, both off by default)
  // -------------------------------------------------------------------------

  const hostCwd = (() => {
    try {
      return process.cwd()
    } catch {
      return '.'
    }
  })()

  const resolvePath = (value) => (isAbsolute(value) ? value : resolve(hostCwd, value))

  let saveTimer = null

  function saveState(cfg) {
    if (!cfg.persistPath) return
    try {
      const path = resolvePath(cfg.persistPath)
      mkdirSync(dirname(path), { recursive: true })
      // `list()` is newest-first; persist in insertion order so a restore keeps
      // the same chronology.
      writeFileSync(path, serializeStore(store.list().reverse(), Date.now()), 'utf8')
    } catch (error) {
      log('warn', `persist failed: ${error && error.message ? error.message : String(error)}`)
    }
  }

  function scheduleSave(cfg) {
    if (!cfg.persistPath) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveState(cfg)
    }, SAVE_DEBOUNCE_MS)
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function restoreState(cfg) {
    if (!cfg.persistPath) return 0
    try {
      const path = resolvePath(cfg.persistPath)
      if (!existsSync(path)) return 0
      const rows = deserializeStore(readFileSync(path, 'utf8'))
      if (rows.length === 0) return 0
      store.replaceAll(rows, { source: 'persist' })
      return rows.length
    } catch (error) {
      log('warn', `persist restore failed: ${error && error.message ? error.message : String(error)}`)
      return 0
    }
  }

  function loadSeed(cfg) {
    if (!cfg.seedFile) return 0
    try {
      const path = resolvePath(cfg.seedFile)
      if (!existsSync(path)) {
        log('warn', `seed file not found: ${path}`)
        return 0
      }
      // Document order is "most important first", and the panel lists the newest
      // hint on top, so the seed is pushed back-to-front.
      const inputs = parseSeed(readFileSync(path, 'utf8'), path).reverse()
      return store.pushMany(inputs, { source: 'seed' }).length
    } catch (error) {
      log('warn', `seed failed: ${error && error.message ? error.message : String(error)}`)
      return 0
    }
  }

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  function sendJson(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  async function readBody(req) {
    let raw = ''
    try {
      for await (const chunk of req) raw += chunk
    } catch {
      return {}
    }
    try {
      const parsed = JSON.parse(raw || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function snapshot(cfg) {
    const stats = store.stats()
    return {
      ok: true,
      enabled: cfg.enabled,
      version: HINT_PART_VERSION,
      ts: Date.now(),
      unread: stats.unread,
      unreadError: stats.unreadError,
      total: stats.total,
      stats: { byLevel: stats.byLevel, maxHints: stats.maxHints },
      config: publicConfig(cfg),
    }
  }

  const listHandler = async (req, res) => {
    try {
      const cfg = effectiveConfig()
      const url = new URL(req.url || '/', 'http://localhost')
      const sinceRaw = url.searchParams.get('since')
      const limitRaw = url.searchParams.get('limit')
      const payload = snapshot(cfg)
      payload.hints = store.list({
        since: sinceRaw === null || sinceRaw === '' ? undefined : Number(sinceRaw),
        limit: limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw),
      })
      sendJson(res, 200, payload)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const pushHandler = async (req, res) => {
    try {
      const cfg = effectiveConfig()
      if (!cfg.enabled) {
        sendJson(res, 409, { ok: false, error: 'disabled' })
        return
      }
      const body = await readBody(req)
      const source = typeof body.source === 'string' && body.source ? body.source : 'http'
      const payload = Array.isArray(body.hints)
        ? body.hints
        : Array.isArray(body.items)
          ? body.items
          : body
      const added = store.pushMany(payload, { source })
      if (added.length === 0) {
        sendJson(res, 400, { ok: false, error: 'title-or-body-required' })
        return
      }
      scheduleSave(cfg)
      const stats = store.stats()
      sendJson(res, 200, {
        ok: true,
        added: added.length,
        hint: added[0],
        hints: added,
        unread: stats.unread,
        total: stats.total,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const readHandler = async (req, res) => {
    try {
      const cfg = effectiveConfig()
      const body = await readBody(req)
      const ids = Array.isArray(body.ids) ? body.ids : typeof body.id === 'string' ? [body.id] : []
      const changed = store.markRead({ all: body.all === true, ids })
      if (changed > 0) scheduleSave(cfg)
      const stats = store.stats()
      sendJson(res, 200, { ok: true, changed, unread: stats.unread, total: stats.total })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const clearHandler = async (req, res) => {
    try {
      const cfg = effectiveConfig()
      const body = await readBody(req)
      const removed = store.clear({ onlyRead: body.onlyRead === true || body.read === true })
      if (removed > 0) scheduleSave(cfg)
      const stats = store.stats()
      sendJson(res, 200, { ok: true, removed, unread: stats.unread, total: stats.total })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  /**
   * Runtime configuration, used by the browser half's Settings → Hint Ball
   * section (there is no client-side settings service in this build).
   *
   * `POST /hint/config { maxHints?, autoOpenOnError?, seedFile?, persistPath?,
   * pollMs?, enabled? }` -> `{ ok, applied, needsReload, config }`
   * `POST /hint/config { reset: true }` clears the runtime layer again.
   *
   * Deliberately NOT gated by `enabled`: this is the route that turns the
   * plugin back on.
   */
  const configHandler = async (req, res) => {
    try {
      const body = await readBody(req)
      if (body.reset === true) {
        runtimeOverrides = {}
        sendJson(res, 200, { ok: true, applied: [], needsReload: [], reset: true, config: publicConfig(effectiveConfig()) })
        return
      }
      const patch = sanitizeConfigPatch(body)
      const applied = Object.keys(patch)
      if (applied.length === 0) {
        sendJson(res, 400, { ok: false, error: 'no-config-keys' })
        return
      }
      runtimeOverrides = { ...runtimeOverrides, ...patch }
      const cfg = effectiveConfig()
      // maxHints/pollMs/autoOpenOnError/enabled take effect on the next request;
      // seedFile is only read at load, persistPath only on the next write.
      const needsReload = ['seedFile', 'persistPath'].filter((key) => applied.indexOf(key) !== -1)
      sendJson(res, 200, { ok: true, applied, needsReload, config: publicConfig(cfg) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const disposers = [
        hostCtx.webServer.register({ kind: 'exact', path: '/hint/list', handler: listHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/hint/push', handler: pushHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/hint/read', handler: readHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/hint/clear', handler: clearHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/hint/config', handler: configHandler }),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    }, 'dsh-hint-handoff: hint routes')
  })

  // -------------------------------------------------------------------------
  // Agent tool: let the model push a hint into the 提示交接 panel by itself
  // -------------------------------------------------------------------------

  ctx.inject(['tools'], (toolCtx) => {
    try {
      const dispose = toolCtx.tools.register({
        name: 'post_hint',
        description:
          'Push a hint (notification) into the DSH 提示交接 panel (sidebar entry 「提示交接」). Use it to surface ' +
          'something the user should see without scrolling the transcript: a finished long task, a warning, a ' +
          'decision that needs attention. level "info" is neutral, "warn" is amber, "error" is red.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'One-line hint title (shown in bold in the list).' },
            body: { type: 'string', description: 'Optional longer text: what happened, what to do next.' },
            level: {
              type: 'string',
              enum: ['info', 'warn', 'error'],
              description: 'Severity; drives the colour. Defaults to "info".',
            },
          },
          required: ['title'],
        },
        output: {
          schema: { type: 'object' },
          render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        async execute(args) {
          const cfg = effectiveConfig()
          if (!cfg.enabled) return { ok: false, error: 'disabled' }
          const hint = store.push(
            { title: args && args.title, body: args && args.body, level: args && args.level },
            { source: 'tool' },
          )
          if (!hint) return { ok: false, error: 'title-or-body-required' }
          scheduleSave(cfg)
          const stats = store.stats()
          return { ok: true, id: hint.id, level: hint.level, unread: stats.unread, total: stats.total }
        },
      })
      toolCtx.effect(() => () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }, 'dsh-hint-handoff: post_hint tool')
    } catch (error) {
      log('warn', `post_hint tool unavailable: ${error && error.message ? error.message : String(error)}`)
    }
  })

  // -------------------------------------------------------------------------
  // Boot: restore persisted hints first, seed only when nothing was restored
  // -------------------------------------------------------------------------

  const bootCfg = effectiveConfig()
  const restored = restoreState(bootCfg)
  const seeded = restored > 0 ? 0 : loadSeed(bootCfg)
  log(
    'info',
    `loaded (maxHints=${bootCfg.maxHints}, enabled=${bootCfg.enabled}, restored=${restored}, seeded=${seeded}); ` +
      'routes: GET /hint/list, POST /hint/push, POST /hint/read, POST /hint/clear, POST /hint/config; tool: post_hint',
  )
}
