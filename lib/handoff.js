/**
 * dsh-hint-handoff — host half, handoff part (merged from dsh-auto-handoff 0.2.0).
 *
 * Watches DSH sessions for *automatic* context compaction. Once the number of
 * successfully completed compaction rounds reaches `threshold` (this merged
 * plugin defaults to 8; the original plugin defaulted to 1), it writes a
 * Markdown handoff file into the session's working directory, optionally
 * archives the session log, and opens a **new** session that reads the handoff
 * file, understands the state, and stands by for the user.
 *
 * Everything below is the original 0.2.0 trigger/action machinery, unchanged
 * except for the merge points:
 *   - the mode picked in the 提示交接 dialog is forwarded to
 *     `sessionController.create({ agentPreset })`, and FULL_ACCESS_PRESET
 *     (danger-full-access + never) is pinned on the new Session before its
 *     first prompt — both modes are full access;
 *   - a successful AUTOMATIC handoff records `entry.lastAutoAt`, exposed by
 *     GET /handoff/state as `autoHandoff.lastAt`, so the dialog's status line
 *     can show 「自动交接 已触发（HH:MM）」 without the user refreshing;
 *   - GET /handoff/state also returns `modes` (the real mode catalog);
 *   - POST /handoff/prepare accepts `mode`, and falls back to the most
 *     recently active Session when no `sessionId` is posted.
 *
 * The switch to the new session never happens while work is in flight:
 *   - the trigger is evaluated only on a `turn/end` event whose
 *     `reason.kind === 'completed'` (no error, no abort, no max-tokens cut);
 *   - a pre-flight re-check runs one macrotask later and requires the live Agent
 *     status to be `idle`, no open turn, and no unanswered `tool/call`;
 *   - if any check fails the attempt is deferred to the next completed turn.
 *
 * Everything named here was read out of the shipped DSH packages of Desktop
 * 0.2.0-rc.2 (`@deepseek-ai/dsh-session`, `dsh-agent`, `dsh-agent-loop`,
 * `dsh-compaction`, `dsh-host-webserver`). See the original plugin's
 * NOTES-prior-art.md for the full verification log.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { clampChars, jsonlOf, renderHandoff, stamp, textOf, titleFromHandoff } from './handoff-doc.js'

/** Build marker, reported by GET /handoff/state so a running Host can be matched to the source. */
const HANDOFF_PART_VERSION = '0.2.0'
/** Merged plugin name, reported by GET /handoff/state as `plugin`. */
const PLUGIN_NAME = 'dsh-hint-handoff'
/** Permission preset every handoff continuation Session is pinned to. */
const FULL_ACCESS_PRESET = 'danger-full-access'
/**
 * Mode catalog of the 「交接会话」 picker. Both rows launch with
 * FULL_ACCESS_PRESET (danger-full-access file policy + never approval policy).
 */
const AGENT_MODE_ROWS = [
  {
    id: 'computer-use',
    name: 'Computer Use 模式',
    description: '桌面 GUI 操作：截图、鼠标键盘与桌面应用自动化。',
  },
  {
    id: 'standard',
    name: '标准模式',
    description: '编码、文档、搜索与子代理工具。',
  },
]

// ---------------------------------------------------------------------------
// Defaults and helpers (independent of the schema, so a partial/absent config
// never breaks `apply`).
// ---------------------------------------------------------------------------

/**
 * Boot-time defaults, as a FUNCTION so it is hoisted: the top-level
 * `schemastery` guard below runs during module evaluation, before a `const`
 * declared further down could be read (temporal dead zone).
 */
function DEFAULTS() {
  return {
    enabled: true,
    threshold: 1,
    instruction: '',
    archive: true,
    maxDigestTokens: 2048,
    keepHandoffs: 20,
    outputDir: '.dsh-handoff',
    digestEnabled: true,
    settleDelayMs: 50,
    idleRetries: 6,
    createNewSession: true,
  }
}

const HANDOFF_LATEST = 'HANDOFF.md'

function numberOr(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * The tool-call identity of a `tool/call` or `tool/result` payload. DSH records
 * both events as `{ turn, step, callId }` / `{ turn, step, message }`, and the
 * tool-result message carries the id it answers; all three spellings are probed
 * so a shape change degrades to "tracked less precisely" instead of silently
 * reporting a phantom unanswered call.
 */
function callIdOf(data) {
  if (!data || typeof data !== 'object') return undefined
  const direct = data.callId ?? data.toolCallId
  if (direct !== undefined && direct !== null) return direct
  const message = data.message
  if (message && typeof message === 'object') {
    const nested = message.callId ?? message.toolCallId
    if (nested !== undefined && nested !== null) return nested
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - boot-time config from `cordis.patch.yml`.
 */
export function registerHandoff(ctx, config = {}) {
  const d = DEFAULTS()
  const boot = {
    enabled: boolOr(config.enabled, d.enabled),
    threshold: numberOr(config.threshold, d.threshold, 1, 100),
    instruction: typeof config.instruction === 'string' ? config.instruction : d.instruction,
    archive: boolOr(config.archive, d.archive),
    maxDigestTokens: numberOr(config.maxDigestTokens, d.maxDigestTokens, 256, 32000),
    keepHandoffs: numberOr(config.keepHandoffs, d.keepHandoffs, 1, 500),
    outputDir: typeof config.outputDir === 'string' && config.outputDir ? config.outputDir : d.outputDir,
    digestEnabled: boolOr(config.digestEnabled, d.digestEnabled),
    settleDelayMs: numberOr(config.settleDelayMs, d.settleDelayMs, 0, 10000),
    idleRetries: numberOr(config.idleRetries, d.idleRetries, 0, 20),
    createNewSession: boolOr(config.createNewSession, d.createNewSession),
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

  // -------------------------------------------------------------------------
  // 「交接会话」 mode catalog + full-access pinning (merge addition)
  //
  // The dialog asks for a mode BEFORE the handoff runs. A mode is the Agent
  // preset the new Session is created with: `standard` is the shipped coding
  // preset, `computer-use` is inserted by the dsh-orb bundle and drives the
  // desktop GUI. BOTH launch with FULL_ACCESS_PRESET pinned on the new Session,
  // exactly like dsh-project-hub's 「启动会话」.
  // -------------------------------------------------------------------------

  /** Resolve the real mode catalog; availability comes from the Agent-preset roster. */
  async function listAgentModes() {
    const presets = service('agentPresets')
    const roster = Boolean(presets && typeof presets.resolve === 'function')
    const rows = []
    for (const row of AGENT_MODE_ROWS) {
      let available = false
      let presetId = null
      if (roster) {
        try {
          const resolved = await presets.resolve(row.id)
          if (row.id === 'standard') {
            // The baseline mode: when the shipped `standard` definition is
            // missing/unhealthy, omit the preset and let the roster default run
            // instead of blocking every handoff.
            available = true
            presetId = resolved && resolved.broken === undefined ? row.id : null
          } else {
            available = Boolean(resolved) && resolved.broken === undefined
            if (available) presetId = row.id
          }
        } catch {
          available = row.id === 'standard'
        }
      } else {
        available = row.id === 'standard'
      }
      rows.push({
        id: row.id,
        name: row.name,
        description: row.description,
        available,
        presetId,
        // Both rows are full access — the dialog prints this as small print.
        fullAccess: true,
        permissionPreset: FULL_ACCESS_PRESET,
      })
    }
    return rows
  }

  /**
   * Validate a requested mode. Unknown ids (and an unavailable Computer Use
   * preset) deliberately fall back to `standard` so the handoff still runs; the
   * answer records what was requested so the dialog can be honest about it.
   */
  async function resolveHandoffMode(rawMode) {
    const requested = typeof rawMode === 'string' && rawMode.trim() ? rawMode.trim() : 'standard'
    const modes = await listAgentModes()
    const known = modes.find((row) => row.id === requested)
    const fallback = modes.find((row) => row.id === 'standard') || modes[0]
    const selected = known || fallback
    return { mode: selected, requested, fellBack: !known }
  }

  /**
   * Pin FULL_ACCESS_PRESET on the freshly created continuation Session BEFORE
   * its queued prompt can run a turn. Best effort: the profile's permission
   * default already covers new Sessions, and a missing permission service must
   * never block the handoff.
   */
  async function pinFullAccess(sessionId) {
    const presets = service('permissionPresets')
    if (!presets || typeof presets.set !== 'function') return null
    const sessionsSvc = service('sessions')
    const session =
      sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(String(sessionId)) : undefined
    if (!session) return null
    try {
      presets.set(session, FULL_ACCESS_PRESET)
      return FULL_ACCESS_PRESET
    } catch (error) {
      log(
        'warn',
        `could not pin ${FULL_ACCESS_PRESET} on ${sessionId}: ${error && error.message ? error.message : String(error)}`,
      )
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Per-session bookkeeping
  // -------------------------------------------------------------------------

  /**
   * @type {Map<string, {
   *   autoRounds: number, manualRounds: number, failedRounds: number,
   *   openCompactions: number, inFlightTools: Map<string, number>,
   *   lastTurnEnd: {turn:number, seq:number, reason:string}|null,
   *   openTurn: number|null, lastHandoffTurn: number|null,
   *   pending: boolean, scheduled: boolean, attempts: number,
   *   ready: null|object, lastError: string|null,
   * }>}
   */
  const sessions = new Map()

  /**
   * Plugin-scoped timestamp of the last SUCCESSFUL automatic handoff (merge
   * addition). The dialog's 「自动交接 已触发（HH:MM）」 must survive the switch
   * to the continuation Session: the new Session has zero compaction rounds and
   * no `ready` payload of its own, so a per-Session value would read as
   * 「未触发」 right after the handoff the user just saw happen.
   */
  let lastAutoHandoffAt = 0

  function stateOf(session) {
    const id = session && session.id
    if (!id) return null
    let entry = sessions.get(id)
    if (!entry) {
      entry = {
        autoRounds: 0,
        manualRounds: 0,
        failedRounds: 0,
        openCompactions: 0,
        compactionStarts: 0,
        compactionSummaries: 0,
        inFlightTools: new Map(),
        lastTurnEnd: null,
        openTurn: null,
        lastHandoffTurn: null,
        pending: false,
        scheduled: false,
        attempts: 0,
        ready: null,
        lastError: null,
        /** Timestamp of the last SUCCESSFUL automatic handoff (merge addition). */
        lastAutoAt: 0,
        timer: null,
        /** Bumped by every event, so the panel can pick a sensible fallback. */
        lastEventAt: 0,
      }
      sessions.set(id, entry)
    }
    return entry
  }

  /**
   * Drop every trace of one session, including a deferred safety re-check that
   * has not fired yet.
   */
  function dropSessionState(id) {
    const entry = sessions.get(id)
    if (entry && entry.timer) {
      try {
        clearTimeout(entry.timer)
      } catch {
        /* ignore */
      }
    }
    if (entry) entry.timer = null
    sessions.delete(id)
  }

  /**
   * Rebuild the counts from a session's own log. Used once per session so a
   * plugin reload (or a profile HMR) does not lose the compaction history that
   * the in-memory map would otherwise miss.
   */
  function hydrate(session, entry) {
    if (entry.hydrated) return
    entry.hydrated = true
    let events = []
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    } catch {
      try {
        events = Array.isArray(session.events) ? session.events : []
      } catch {
        events = []
      }
    }
    for (const event of events) {
      if (!event || typeof event.type !== 'string') continue
      if (event.type === 'compaction/start') entry.openCompactions += 1
      else if (event.type === 'compaction/summary') entry.compactionSummaries += 1
      else if (event.type === 'compaction/end') {
        entry.openCompactions = Math.max(0, entry.openCompactions - 1)
        const data = event.data || {}
        if (typeof data.error === 'string' || (data.error && typeof data.error === 'object')) {
          entry.failedRounds += 1
        } else if (data.sourceCommandId === undefined || data.sourceCommandId === null) {
          entry.autoRounds += 1
        } else {
          entry.manualRounds += 1
        }
      } else if (event.type === 'turn/start') {
        entry.openTurn = event.data && Number.isFinite(Number(event.data.turn)) ? Number(event.data.turn) : entry.openTurn
      } else if (event.type === 'turn/end') {
        entry.openTurn = null
        const data = event.data || {}
        entry.lastTurnEnd = {
          turn: Number(data.turn) || 0,
          seq: event.seq,
          reason: data.reason && data.reason.kind ? String(data.reason.kind) : 'unknown',
        }
      } else if (event.type === 'tool/call') {
        const callId = callIdOf(event.data)
        if (callId !== undefined) entry.inFlightTools.set(String(callId), Number(event.seq) || 0)
      } else if (event.type === 'tool/result') {
        const callId = callIdOf(event.data)
        if (callId !== undefined) entry.inFlightTools.delete(String(callId))
      }
    }
  }

  // -------------------------------------------------------------------------
  // Effective configuration (patch config < persisted/user overrides)
  // -------------------------------------------------------------------------

  /**
   * User overrides written through `POST /handoff/config`.
   *
   * The Web client cannot be trusted to expose a settings service: on Desktop
   * 0.2.0-rc.2 there is **no `settingsScope` client service**, and the
   * `settings.plugin.item` slot does not exist either (verified by scanning the
   * shipped `app.asar`; see NOTES-prior-art.md §3.6). So the plugin persists its
   * own overrides instead of depending on a settings UI:
   *
   *   $DSH_HOME/storages/dsh-hint-handoff/config.json
   *
   * Same pattern the community plugin `dsh-noema` uses for
   * `$DSH_HOME/storages/dsh-noema-imports.json`. Nothing inside the profile is
   * touched, and a missing/unreadable file simply means "no overrides".
   */
  const OVERRIDE_KEYS = [
    'enabled', 'threshold', 'instruction', 'archive', 'maxDigestTokens',
    'keepHandoffs', 'outputDir', 'digestEnabled', 'settleDelayMs', 'idleRetries', 'createNewSession',
  ]
  let overrideCache = null

  function overrideFile() {
    const home = process.env.DSH_HOME || ''
    return home ? join(home, 'storages', 'dsh-hint-handoff', 'config.json') : ''
  }

  /**
   * Read the override file, re-reading whenever its mtime changes so an
   * externally edited file is picked up without a restart.
   */
  function readOverrides() {
    const file = overrideFile()
    if (!file) return {}
    let mtimeMs = null
    try {
      mtimeMs = existsSync(file) ? statSync(file).mtimeMs : null
    } catch {
      mtimeMs = null
    }
    if (overrideCache !== null && overrideCache.mtimeMs === mtimeMs) return overrideCache.value
    let value = {}
    try {
      if (mtimeMs !== null) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed
      }
    } catch (error) {
      log('warn', `cannot read overrides from ${file}: ${error && error.message ? error.message : String(error)}`)
      value = {}
    }
    overrideCache = { mtimeMs, value }
    return value
  }

  function writeOverrides(patch) {
    const file = overrideFile()
    if (!file) return { ok: false, reason: 'dsh-home-unknown' }
    const next = { ...readOverrides() }
    for (const key of OVERRIDE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== null) next[key] = patch[key]
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      return { ok: false, reason: `write-failed: ${error && error.message ? error.message : String(error)}` }
    }
    overrideCache = { mtimeMs: null, value: next }
    try {
      overrideCache = { mtimeMs: statSync(file).mtimeMs, value: next }
    } catch {
      /* the next read re-stats anyway */
    }
    return { ok: true, file, overrides: next }
  }

  function effectiveConfig() {
    const live = readOverrides()
    const base = boot
    return {
      enabled: boolOr(live.enabled, base.enabled),
      threshold: numberOr(live.threshold, base.threshold, 1, 100),
      instruction: typeof live.instruction === 'string' ? live.instruction : base.instruction,
      archive: boolOr(live.archive, base.archive),
      maxDigestTokens: numberOr(live.maxDigestTokens, base.maxDigestTokens, 256, 32000),
      keepHandoffs: numberOr(live.keepHandoffs, base.keepHandoffs, 1, 500),
      outputDir: typeof live.outputDir === 'string' && live.outputDir ? live.outputDir : base.outputDir,
      digestEnabled: boolOr(live.digestEnabled, base.digestEnabled),
      settleDelayMs: numberOr(live.settleDelayMs, base.settleDelayMs, 0, 10000),
      idleRetries: numberOr(live.idleRetries, base.idleRetries, 0, 20),
      createNewSession: boolOr(live.createNewSession, base.createNewSession),
    }
  }

  // -------------------------------------------------------------------------
  // Safety checks — the "safe moment" contract
  // -------------------------------------------------------------------------

  /**
   * Every condition required before a handoff may touch the session or open a
   * new one. Returns a list of reasons; an empty list means "safe".
   */
  function safetyReport(session, entry) {
    const cfg = effectiveConfig()
    const reasons = []
    if (!cfg.enabled) reasons.push('disabled')
    if (!session) reasons.push('session-missing')
    if (entry.openTurn !== null) reasons.push('open-turn')
    if (entry.inFlightTools.size > 0) reasons.push(`unanswered-tool-calls(${entry.inFlightTools.size})`)
    if (entry.openCompactions > 0) reasons.push('compaction-in-flight')
    const last = entry.lastTurnEnd
    if (!last) reasons.push('no-completed-turn')
    else if (last.reason !== 'completed') reasons.push(`last-turn-${last.reason}`)
    if (entry.lastHandoffTurn !== null && last && entry.lastHandoffTurn === last.turn) reasons.push('handoff-already-done-this-turn')
    if (entry.autoRounds < cfg.threshold) reasons.push(`compaction-rounds(${entry.autoRounds}/${cfg.threshold})`)
    const agent = service('agents') && typeof service('agents').get === 'function' ? service('agents').get(session.id) : undefined
    if (agent && agent.status !== 'idle') reasons.push(`agent-${agent.status}`)
    return { reasons, safe: reasons.length === 0, agent }
  }

  /**
   * First user message of the session — the LAST-resort title source (a long
   * session's first message usually describes work that is long finished).
   */
  function firstUserText(session) {
    try {
      const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
      for (const message of messages) {
        if (message && message.role === 'user') {
          const text = textOf(message.content)
          if (text && text.trim()) return text
        }
      }
    } catch {
      /* fall through to the event log */
    }
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (const event of events) {
        if (event && event.type === 'user/message' && event.data && event.data.message) {
          const text = textOf(event.data.message.content)
          if (text && text.trim()) return text
        }
      }
    } catch {
      /* ignore */
    }
    return ''
  }

  /**
   * MOST RECENT user message of the session — the preferred degraded-path title
   * source: in a long session the latest message is what is being worked on now,
   * while the first one is stale history.
   */
  function lastUserText(session) {
    try {
      const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message && message.role === 'user') {
          const text = textOf(message.content)
          if (text && text.trim()) return text
        }
      }
    } catch {
      /* fall through to the event log */
    }
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event && event.type === 'user/message' && event.data && event.data.message) {
          const text = textOf(event.data.message.content)
          if (text && text.trim()) return text
        }
      }
    } catch {
      /* ignore */
    }
    return ''
  }

  /** The title the session currently shows, when the host keeps one. */
  function previousTitleOf(session) {
    const header = session && session.header ? session.header : null
    const candidates = [session && session.title, header && header.title, header && header.name]
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  /** Latest assistant text of the session, used for the deterministic summary. */
  function lastAssistantText(session) {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event && event.type === 'assistant/message' && event.data && event.data.message) {
          const text = textOf(event.data.message.content)
          if (text) return text
        }
      }
    } catch {
      /* ignore */
    }
    return ''
  }

  /** Last `workspace/changes` file list, when the workspace-changes plugin is on. */
  function changedFiles(session) {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event && event.type === 'workspace/changes' && event.data) {
          const files = event.data.files
          if (Array.isArray(files) && files.length > 0) {
            return files
              .map((file) => (typeof file === 'string' ? file : file && (file.path || file.file || file.name)))
              .filter((value) => typeof value === 'string' && value.length > 0)
              .slice(0, 200)
          }
        }
      }
    } catch {
      /* ignore */
    }
    return []
  }

  function routeOf(session) {
    try {
      const rc = typeof session.requestContext === 'function' ? session.requestContext() : undefined
      if (rc && rc.provider && rc.model) return { provider: rc.provider, model: rc.model }
    } catch {
      /* ignore */
    }
    const llm = service('llm')
    if (llm) {
      try {
        const rc = typeof session.requestContext === 'function' ? session.requestContext() : undefined
        if (rc && rc.provider && rc.model) return { provider: rc.provider, model: rc.model }
      } catch {
        /* ignore */
      }
    }
    const adm = service('agentDefaultModel')
    if (adm && typeof adm.currentSelection === 'function') {
      try {
        const selection = adm.currentSelection()
        if (selection && selection.provider && selection.model) {
          return { provider: selection.provider, model: selection.model }
        }
      } catch {
        /* ignore */
      }
    }
    const settings = service('settings')
    if (settings && typeof settings.get === 'function') {
      try {
        const cfg = settings.get('agent-default-model')
        if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
      } catch {
        /* ignore */
      }
    }
    return null
  }

  function contextState(session) {
    const projections = service('sessionProjections')
    let used = null
    let window = null
    if (projections && typeof projections.snapshot === 'function') {
      try {
        const snap = projections.snapshot(session)
        const pressure = snap && snap.contextPressure
        if (pressure) {
          used = pressure.projectedTokens != null ? pressure.projectedTokens : pressure.pressureTokens
          window = pressure.contextWindow
        }
      } catch {
        /* ignore */
      }
    }
    const meter = service('tokenMeter')
    if (used == null && meter && typeof meter.measure === 'function') {
      try {
        const measured = meter.measure(session)
        if (measured) used = measured.totalTokens
      } catch {
        /* ignore */
      }
    }
    if (window == null) {
      try {
        const rc = typeof session.requestContext === 'function' ? session.requestContext() : undefined
        if (rc && rc.contextWindow) window = rc.contextWindow
      } catch {
        /* ignore */
      }
    }
    return { usedTokens: used, contextWindow: window }
  }

  // -------------------------------------------------------------------------
  // Digest (LLM summary), with a deterministic fallback
  // -------------------------------------------------------------------------

  async function buildDigest(session, cfg) {
    if (!cfg.digestEnabled) return { source: 'disabled', text: '' }
    const llm = service('llm')
    let messages = []
    try {
      messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    } catch {
      messages = []
    }
    const route = routeOf(session)
    if (!llm || !route || messages.length === 0) return { source: 'unavailable', text: '' }
    const system = [
      '你是 DSH 的「交接班记录官」。当前会话已连续自动压缩多轮，用户即将开启一个新会话继续同一份工作。',
      '请用简体中文输出一份可直接被下一个会话接手的工作交接摘要，按以下小节组织（没有内容的小节写「无」）：',
      '1) 用户目标与当前任务进度；2) 已完成的关键工作（改了哪些文件、跑了什么命令、得到什么结论）；',
      '3) 尚未完成的事项与下一步计划；4) 重要路径/命令/数据/约定；5) 风险与不要踩的坑。',
      '要求：只写事实，不要寒暄，不要复述整段对话，600~1200 字。',
    ].join('\n')
    let text = ''
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: messages.slice(-48),
        system,
        purpose: 'compaction',
        maxTokens: cfg.maxDigestTokens,
      })
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk && (chunk.type === 'finish' || chunk.type === 'error' || chunk.type === 'aborted')) break
      }
    } catch (error) {
      log('warn', `digest stream failed: ${error && error.message ? error.message : String(error)}`)
      return { source: 'failed', text: '' }
    }
    text = text.trim()
    if (!text) return { source: 'empty', text: '' }
    return { source: 'llm', text: clampChars(text, cfg.maxDigestTokens) }
  }

  // -------------------------------------------------------------------------
  // Handoff document + archive
  // -------------------------------------------------------------------------

  function resolveOutputDir(session, cfg) {
    const cwd = (session.header && session.header.cwd) || process.cwd()
    const dir = isAbsolute(cfg.outputDir) ? cfg.outputDir : resolve(cwd, cfg.outputDir)
    return { cwd, dir }
  }

  /**
   * Keep at most `keep` dated handoff documents so the workspace stays clean.
   *
   * Only the `HANDOFF-<timestamp>.md` series is pruned, and the sort is
   * lexicographic on a zero-padded `YYYYMMDD-HHMMSS` stamp, i.e. chronological.
   * The loop therefore always drops the OLDEST first and stops at `keep >= 1`
   * files, so the newest document — the one this run just wrote and is still
   * handing to the continuation session — can never be the victim. `HANDOFF.md`
   * is not part of the series: it is the single fixed-name pointer and is
   * simply overwritten on every handoff.
   */
  function pruneHandoffs(dir, keep) {
    try {
      const names = readdirSync(dir)
        .filter((name) => /^HANDOFF-\d{8}-\d{6}\.md$/.test(name))
        .sort()
      while (names.length > keep) {
        const victim = names.shift()
        try {
          unlinkSync(join(dir, victim))
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Self-healing sweep for the hidden `.HANDOFF.<ts>.prev.md` files that
   * releases before 0.2.1 of this plugin left in the workspace.
   *
   * Why there is no `.prev` backup any more (do not reintroduce one):
   *   - **History is already complete.** Every handoff writes its own
   *     `HANDOFF-<timestamp>.md` and never overwrites an older one, so the whole
   *     series is on disk. Nothing is lost by not copying the previous
   *     `HANDOFF.md` aside — measured on a real workspace, each `.prev.md` was
   *     **byte-for-byte identical** to the dated file of the handoff that had
   *     produced it. It was a duplicate, not a backup.
   *   - **It was invisible to cleanup.** `pruneHandoffs()` matches
   *     `^HANDOFF-\d{8}-\d{6}\.md$`, which a leading-dot name never matches, so
   *     `keepHandoffs` could not bound the backups: they grew by one per handoff
   *     for the lifetime of the workspace.
   *   - **`HANDOFF.md` is a pointer, not a document.** It only exists so a human
   *     can open "the latest one" without reading a timestamp; the current
   *     handoff is always addressed by its dated name (see `handoffFile`).
   *
   * Only the exact legacy pattern is touched, so an unrelated dotfile is never
   * deleted. Returns how many files were removed so the caller can log it.
   */
  function sweepPrevBackups(dir) {
    let removed = 0
    try {
      for (const name of readdirSync(dir)) {
        if (!/^\.HANDOFF\.\d{8}-\d{6}\.prev\.md$/.test(name)) continue
        try {
          unlinkSync(join(dir, name))
          removed += 1
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return removed
  }

  function writeHandoffFiles(session, entry, cfg, digest) {
    const { cwd, dir } = resolveOutputDir(session, cfg)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const now = new Date()
    const agent = service('agents') && typeof service('agents').get === 'function' ? service('agents').get(session.id) : undefined
    const route = routeOf(session)
    const context = contextState(session)
    const files = changedFiles(session)
    const archiveDir = join(dir, 'archive', session.id)

    const text = renderHandoff({
      now,
      session: session.id,
      cwd,
      outputDir: dir,
      autoRounds: entry.autoRounds,
      manualRounds: entry.manualRounds,
      threshold: cfg.threshold,
      lastTurn: entry.lastTurnEnd ? entry.lastTurnEnd.turn : null,
      agentStatus: agent ? agent.status : 'unknown',
      route: route ? `${route.provider}/${route.model}` : 'unknown',
      context,
      digest,
      files,
      archiveDir,
      fallbackText: lastAssistantText(session),
    })

    // One dated document per handoff — this is the handoff, and it is never
    // rewritten afterwards, so the series is the complete history.
    const dated = join(dir, `HANDOFF-${stamp(now)}.md`)
    writeFileSync(dated, text, 'utf8')
    // …plus the fixed-name pointer, kept ONLY for humans ("open the latest
    // one"). It is overwritten in place on every handoff and is deliberately
    // NOT what `handoffFile` / the continuation instruction point at.
    const latest = join(dir, HANDOFF_LATEST)
    // No `.prev.md` copy of the outgoing pointer — see sweepPrevBackups(). The
    // dated file above already holds exactly that content byte for byte, and a
    // leading-dot file escapes pruneHandoffs(), so it could only pile up.
    const swept = sweepPrevBackups(dir)
    if (swept > 0) log('info', `removed ${swept} leftover .HANDOFF.<timestamp>.prev.md backup file(s)`)
    writeFileSync(latest, text, 'utf8')
    pruneHandoffs(dir, cfg.keepHandoffs)
    return { dir, cwd, file: dated, latest, markdown: text }
  }

  /**
   * Archive = a self-contained JSONL dump of the session's own log, written next
   * to the handoff file. DSH *does* ship a session-log export package
   * (`@deepseek-ai/dsh-session-log-export`), but per its README it produces a
   * **browser download** and deliberately exposes no host-side export call, so a
   * headless archive writes the log itself and says so in the log line.
   */
  async function writeArchive(session, cfg) {
    const sessionsSvc = service('sessions')
    try {
      if (sessionsSvc && typeof sessionsSvc.flush === 'function') await sessionsSvc.flush(session)
    } catch (error) {
      log('warn', `session flush before archive failed: ${error && error.message ? error.message : String(error)}`)
    }
    const { dir } = resolveOutputDir(session, cfg)
    const target = join(dir, 'archive', session.id)
    if (!existsSync(target)) mkdirSync(target, { recursive: true })
    let events = []
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    } catch (error) {
      log('warn', `cannot read session log for archive: ${error && error.message ? error.message : String(error)}`)
      return { ok: false, reason: 'log-unreadable' }
    }
    const logFile = join(target, 'session.jsonl')
    writeFileSync(logFile, jsonlOf(events), 'utf8')
    const manifest = {
      generator: 'dsh-hint-handoff',
      sessionId: session.id,
      archivedAt: new Date().toISOString(),
      eventCount: events.length,
      lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
      header: session.header ? { ...session.header } : null,
      note:
        'DSH 自带的 @deepseek-ai/dsh-session-log-export 只提供浏览器下载（/export 或 Session Header 菜单），' +
        '没有宿主端导出 API；因此本归档由插件直接序列化会话事件日志。',
    }
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return { ok: true, dir: target, logFile, eventCount: events.length }
  }

  // -------------------------------------------------------------------------
  // The handoff itself
  // -------------------------------------------------------------------------

  async function runHandoff(session, entry, trigger, options = {}) {
    const cfg = effectiveConfig()
    const force = options.force === true
    const report = safetyReport(session, entry)
    // `force` is the human escape hatch (the UI's "强制交接" and the `handoff_now`
    // tool): it skips the *policy* reasons (round count, threshold, latch) but
    // never the *physical* ones — an open turn, an unanswered tool call or a
    // compaction still in flight always refuses.
    if (!report.safe && !force) {
      stateOf(session).lastError = `unsafe: ${report.reasons.join(',')}`
      return { ok: false, error: 'unsafe', reasons: report.reasons }
    }
    if (force) {
      const physical = report.reasons.filter((reason) =>
        reason === 'open-turn' ||
        reason.startsWith('unanswered-tool-calls') ||
        reason === 'compaction-in-flight' ||
        reason === 'session-missing',
      )
      if (physical.length > 0) {
        stateOf(session).lastError = `unsafe: ${physical.join(',')}`
        return { ok: false, error: 'unsafe', reasons: physical }
      }
    }
    // Latch before the first await: a second turn/end must not start a twin run.
    entry.lastHandoffTurn = entry.lastTurnEnd ? entry.lastTurnEnd.turn : null
    entry.pending = true
    entry.ready = null
    log('info', `handoff start (${trigger}) session=${session.id} rounds=${entry.autoRounds}/${cfg.threshold}`)

    let written = null
    let archive = { ok: false, reason: 'disabled' }
    try {
      const digest = await buildDigest(session, cfg)
      written = writeHandoffFiles(session, entry, cfg, digest)
      if (cfg.archive) archive = await writeArchive(session, cfg)
      else log('info', 'archive skipped: archive=false')
    } catch (error) {
      entry.pending = false
      entry.lastError = error && error.message ? String(error.message) : String(error)
      log('error', `handoff failed: ${entry.lastError}`)
      return { ok: false, error: entry.lastError }
    }

    // First prompt of the new session, in precedence order:
    //   1. `options.instruction` — typed into the ball panel's 交接指令 box and
    //      posted as `POST /handoff/prepare { instruction }` (most specific);
    //   2. `config.instruction` from `cordis.patch.yml` (static override);
    //   3. the built-in standby wording.
    //
    // The built-in wording names THIS run's dated file, never the fixed-name
    // `HANDOFF.md`. The pointer is overwritten by the next handoff, so an
    // instruction that quoted the pointer would silently redirect the new
    // session to a different document than the handoff it was created for; the
    // dated name stays correct forever.
    const instruction =
      (typeof options.instruction === 'string' && options.instruction.trim() ? options.instruction.trim() : '') ||
      cfg.instruction ||
      defaultInstruction(written.file, written.cwd)

    // Create the continuation Session on the HOST. If this succeeds, the
    // handoff is already complete regardless of what the page does next; the
    // browser half only has to reveal the new Session.
    let continuation = { ok: false, reason: 'disabled' }
    if (cfg.createNewSession) {
      continuation = await openContinuationSession(session, cfg, {
        file: written.file,
        latest: written.latest,
        cwd: written.cwd,
        markdown: written.markdown,
        instruction,
        // Merge addition: the mode chosen in the 提示交接 dialog drives the new
        // Session's Agent preset; FULL_ACCESS_PRESET is pinned inside.
        mode: options.mode || null,
        agentPreset: options.agentPreset || null,
      })
      if (!continuation.ok) {
        log('warn', `host-side session creation failed (${continuation.reason}); the browser half will create it instead`)
      }
    } else {
      log('info', 'host-side session creation disabled (createNewSession=false); the browser half will create it')
    }

    entry.ready = {
      ok: true,
      sessionId: session.id,
      fromSession: session.id,
      cwd: written.cwd,
      outputDir: written.dir,
      // `handoffFile` is the DATED document of THIS handoff — the file the
      // continuation session is told to read, and the path the ball panel shows.
      // The browser half must never be handed the pointer instead: `HANDOFF.md`
      // is overwritten by the next handoff, which would turn "read your handoff"
      // into "read someone else's". `handoffLatest` stays alongside it purely as
      // the human-readable "newest one" address.
      handoffFile: written.file,
      handoffLatest: written.latest,
      handoffMarkdown: written.markdown,
      archive,
      compactions: { auto: entry.autoRounds, manual: entry.manualRounds, threshold: cfg.threshold },
      turn: entry.lastTurnEnd ? entry.lastTurnEnd.turn : null,
      at: Date.now(),
      instruction,
      // Set when the host already opened the continuation Session; the browser
      // half then only navigates to it and must NOT create a second one.
      newSessionId: continuation.ok ? continuation.sessionId : null,
      newSessionTitle: continuation.ok ? continuation.title : '',
      newSessionError: continuation.ok ? '' : continuation.reason,
      // Merge additions: the requested mode, the Agent preset the new Session
      // was created with, the permission preset that was pinned on it, and
      // which trigger produced this handoff ('auto' / 'manual' / 'http' / tool).
      mode: options.mode || null,
      agentPreset: continuation.ok ? continuation.agentPreset || null : options.agentPreset || null,
      permissionPreset: continuation.ok ? continuation.permissionPreset || null : null,
      trigger,
      consumed: false,
    }
    entry.lastError = null
    // Merge addition: remember when the AUTOMATIC trigger last fired, so
    // GET /handoff/state can show 「自动交接 已触发（HH:MM）」 even after the
    // `ready` payload was consumed, the page was reloaded, or the user moved to
    // the continuation Session.
    if (trigger === 'auto') {
      entry.lastAutoAt = entry.ready.at
      lastAutoHandoffAt = entry.lastAutoAt
    }
    log('info', `handoff written: ${written.file} (archive=${archive.ok ? archive.dir : archive.reason})`)
    return entry.ready
  }

  /**
   * The first prompt of the continuation Session — READ, UNDERSTAND, STAND BY.
   *
   * It must NOT invite the new session to resume the work. An earlier wording
   * ("继续未完成的工作…") made the fresh session start acting the moment it was
   * created: a real handoff at 13:14 ran unattended until 13:19 and burned
   * tokens until the user stopped it. Reading the handoff file is the whole
   * job; when work resumes is the user's call.
   *
   * Still overridable, unchanged: `cordis.patch.yml` → `config.instruction`,
   * or the 交接指令 box in the ball panel (same key, via POST /handoff/prepare).
   *
   * @param {string} file - absolute path of THIS handoff's dated document
   *   (`HANDOFF-<timestamp>.md`); callers must not pass the `HANDOFF.md`
   *   pointer, which a later handoff overwrites.
   * @param {string} cwd - the workspace the new session must work in.
   */
  function defaultInstruction(file, cwd) {
    return [
      '这是一次「交接班」：上一个会话因为上下文被自动压缩多轮，已经把它自己的工作状态写成了交接文件。',
      '',
      `请先完整读取这个交接文件：${file}`,
      '',
      `读完后请理解：任务目标、当前进度、已完成项与硬性约定（工作目录：${cwd}）。`,
      '',
      '然后**停在这里待命** —— 不要开始任何新的操作、不要修改任何文件、不要调用工具；',
      '用一两句话回报「我已经读完并理解了交接内容」，然后等用户给出下一步指示。',
      '',
      '⚠️ 不要自动继续上一个会话的工作，也不要自行推断下一步该做什么。',
    ].join('\n')
  }

  /**
   * Host-side creation of the continuation Session.
   *
   * `ctx.sessionController.create()` + `.prompt()` is the same Host API the
   * shipped `dsh-new-session` plugin uses: the created Session is an ORDINARY
   * top-level session (no `parentSession` lineage, no subagent origin) that
   * appears in the GUI session list and starts working on the prompt
   * immediately. Creating it here rather than in the browser means the
   * handoff itself is complete even if the page never navigates.
   *
   * Verified against `deepseek-ai/deepseek-harness@dsh-v0.2.0-rc.2`:
   *   SessionCreateRequest { workspaceId? | cwd?; sessionId?; agentPreset? }
   *   SessionPromptRequest { requestId; sessionId; mode: 'queue' | 'steer'; content }
   *   SessionRenameRequest { sessionId; title }
   */
  async function openContinuationSession(session, cfg, handoff) {
    const controller = service('sessionController')
    if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
      return { ok: false, reason: 'session-controller-unavailable' }
    }
    // The continuation session MUST land back in the ORIGINAL session's
    // workspace, because the DSH sidebar groups sessions BY WORKSPACE: a request
    // that carries only `cwd` belongs to no existing workspace and the new
    // session therefore shows up under 「未分组」. `workspaceId` is preferred for
    // exactly that reason, and it does not cost the directory: the workspace's
    // own directory IS the original folder, so "用原文件夹" is satisfied too.
    // `cwd` stays as the fallback for a session whose workspace cannot be
    // resolved (it is the only way to pin the directory then). Do NOT "optimise"
    // this back to cwd-first — that is the bug this comment exists to prevent.
    //
    // Fallback order:
    //   1. workspaceId — the original session's own header, else the registry
    //      workspace that lists this session (preferred: keeps the grouping);
    //   2. cwd — the original session's directory, when no workspace is known;
    //   3. the host default.
    //
    // Single-select semantics: `SessionCreateRequest` is `workspaceId? | cwd?`
    // (verified against dsh-v0.2.0-rc.2), so the two are never sent together.
    const cwd = (session.header && session.header.cwd) || undefined
    let workspaceId = (session.header && session.header.workspaceId) || session.workspaceId || undefined
    if (workspaceId === undefined) {
      try {
        const registry = service('workspaceRegistry')
        if (registry && typeof registry.list === 'function') {
          const owner = registry.list().find((workspace) =>
            workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(session.id))
          if (owner && owner.id) workspaceId = owner.id
        }
      } catch {
        /* fall through to cwd / the host default */
      }
    }
    const createRequest = workspaceId !== undefined ? { workspaceId } : (cwd !== undefined ? { cwd } : {})
    // Merge addition: the mode picked in the 提示交接 dialog becomes the new
    // Session's Agent preset. Only sent when the mode catalog resolved a
    // healthy preset (`standard` may legitimately fall back to the roster
    // default, and that is expressed by omitting the field).
    if (handoff.agentPreset) createRequest.agentPreset = handoff.agentPreset

    let created
    try {
      created = await controller.create(createRequest)
    } catch (error) {
      return { ok: false, reason: `create-failed: ${error && error.message ? error.message : String(error)}` }
    }
    const sessionId = created && created.sessionId ? String(created.sessionId) : ''
    if (!sessionId) return { ok: false, reason: 'create-returned-no-session-id' }

    // A title makes the new row findable; a refusal is not fatal. It is derived
    // from the handoff content (the 任务目标/当前进度 section), never from the old
    // `交接 · <short code>` form — see `titleFromHandoff()`.
    //
    // When the digest was unavailable that section holds no task description, so
    // the strategy degrades in this order: the original session's own current
    // title → the MOST RECENT user message (in a long session the latest message
    // is the work in progress; the first one is stale) → the first user message.
    let title = ''
    if (typeof controller.rename === 'function') {
      title = titleFromHandoff(handoff.markdown || '', {
        firstUserText: firstUserText(session),
        recentUserText: lastUserText(session),
        previousTitle: previousTitleOf(session),
      })
      try {
        await controller.rename({ sessionId, title })
      } catch (error) {
        log('warn', `new session rename refused: ${error && error.message ? error.message : String(error)}`)
        title = ''
      }
    }

    // Merge addition: BOTH modes are full access. Pin the permission preset on
    // the new Session before the queued prompt can run a turn, using the same
    // host call dsh-project-hub's 「启动会话」 uses. Best effort by design.
    const permissionPreset = await pinFullAccess(sessionId)

    const instruction = handoff.instruction
    const requestId = `dsh-hint-handoff-${randomUUID()}`
    try {
      const receipt = await controller.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: instruction }],
      }, AbortSignal.timeout(20000))
      if (!receipt || receipt.accepted !== true) {
        return { ok: false, reason: 'prompt-not-accepted', sessionId }
      }
    } catch (error) {
      return {
        ok: false,
        reason: `prompt-failed: ${error && error.message ? error.message : String(error)}`,
        sessionId,
      }
    }
    // Log the target that was ACTUALLY sent to `create()`, plus BOTH raw values:
    // when a continuation lands in the wrong group, the workspaceId/cwd pair is
    // the first thing to look at.
    const target =
      workspaceId !== undefined ? `workspaceId=${workspaceId}` : (cwd !== undefined ? `cwd=${cwd}` : 'cwd=default')
    log('info', `continuation session ${sessionId} created and prompted (${target}, title=${JSON.stringify(title)})`)
    log(
      'info',
      `continuation target values: workspaceId=${workspaceId === undefined ? '(none)' : workspaceId}, ` +
        `cwd=${cwd === undefined ? '(none)' : cwd}`,
    )
    return {
      ok: true,
      sessionId,
      title,
      workspaceId: workspaceId || null,
      cwd: cwd || null,
      requestId,
      // Merge additions — what the dialog asked for vs. what was applied.
      mode: handoff.mode || null,
      agentPreset: handoff.agentPreset || null,
      permissionPreset: permissionPreset || null,
    }
  }

  /** Defer, re-check, then run — never in the middle of a step. */
  function scheduleHandoff(session, entry) {
    if (entry.scheduled || entry.pending) return
    entry.scheduled = true
    entry.attempts = 0
    const cfg = effectiveConfig()
    const tick = () => {
      const current = sessions.get(session.id)
      if (current !== entry) return // state was dropped (session/agent disposed)
      entry.scheduled = false
      entry.timer = null
      const report = safetyReport(session, entry)
      if (report.safe) {
        runHandoff(session, entry, 'auto').catch((error) => {
          log('error', `handoff threw: ${error && error.message ? error.message : String(error)}`)
        })
        return
      }
      // `no-completed-turn` after the turn ended means the agent opened a new
      // turn in the meantime — defer to its next completed turn.
      if (report.reasons.includes('no-completed-turn')) return
      if (entry.attempts < cfg.idleRetries && report.reasons.every((reason) => reason.startsWith('agent-') || reason === 'compaction-in-flight')) {
        entry.attempts += 1
        entry.scheduled = true
        const delay = Math.min(2000, 50 * 2 ** entry.attempts)
        const timer = setTimeout(tick, delay)
        entry.timer = timer
        if (timer && typeof timer.unref === 'function') timer.unref()
        return
      }
      if (!report.reasons.includes('no-completed-turn')) {
        log('info', `handoff deferred: ${report.reasons.join(',')}`)
      }
    }
    const delay = Math.max(0, cfg.settleDelayMs)
    const timer = setTimeout(tick, delay)
    entry.timer = timer
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  // -------------------------------------------------------------------------
  // Session event wiring
  // -------------------------------------------------------------------------

  /**
   * `turn/end` and `compaction/*` are **session-log events**, not Cordis event
   * names: the session service declares only `session/created`, `session/disposed`,
   * `session/event` and `session/flush` on `ctx.on`, so the log is the only way
   * to see a turn boundary. Confirmed first-hand by the community plugin
   * `2JumpSinA/dsh-context-guard` ("`turn/end` 不是 `ctx.on` 事件名 … 都是日志事件")
   * and by this repository's own listener.
   *
   * `{ global: true }` matches what the community plugins use
   * (`Hugo16/dsh-session-rotate-on-compact`, `billion-context-dsh`) so the
   * subscription is not scope-filtered by whichever fiber mounted it.
   */
  ctx.on('session/event', (session, event) => {
    if (!session || !event || typeof event.type !== 'string') return
    const entry = stateOf(session)
    if (!entry) return
    entry.lastEventAt = Date.now()
    if (!entry.hydrated) {
      // First event ever seen for this session: fold the log that already
      // exists — which INCLUDES this event — and stop; re-applying `event` on
      // top of the fold would double-count it.
      hydrate(session, entry)
      return
    }
    const data = event.data || {}

    switch (event.type) {
      case 'compaction/start':
        entry.openCompactions += 1
        entry.compactionStarts += 1
        break
      case 'compaction/summary':
        entry.compactionSummaries += 1
        break
      case 'compaction/end': {
        entry.openCompactions = Math.max(0, entry.openCompactions - 1)
        const failed = data.error !== undefined && data.error !== null
        if (failed) entry.failedRounds += 1
        else if (data.sourceCommandId === undefined || data.sourceCommandId === null) {
          entry.autoRounds += 1
          const cfg = effectiveConfig()
          if (cfg.enabled && entry.autoRounds >= cfg.threshold) {
            log('info', `compaction round ${entry.autoRounds}/${cfg.threshold} reached for session=${session.id}; waiting for a safe moment`)
          }
        } else entry.manualRounds += 1
        // Upstream-rename self-check: seeing `compaction/start` but no
        // `summary`/`end` would mean the event vocabulary moved under us and the
        // trigger has silently degraded. Say it out loud instead.
        if (entry.compactionStarts > 0 && entry.compactionSummaries === 0 && entry.autoRounds + entry.manualRounds + entry.failedRounds === 0) {
          log('warn', 'compaction/start seen but neither compaction/summary nor a countable compaction/end followed; the compaction event vocabulary may have changed — the handoff trigger is not counting anything')
        }
        break
      }
      case 'turn/start':
        entry.openTurn = Number.isFinite(Number(data.turn)) ? Number(data.turn) : entry.openTurn
        break
      case 'turn/end': {
        const reason = data.reason && data.reason.kind ? String(data.reason.kind) : 'unknown'
        entry.lastTurnEnd = { turn: Number(data.turn) || 0, seq: event.seq, reason }
        entry.openTurn = null
        if (reason !== 'completed') break
        const cfg = effectiveConfig()
        if (!cfg.enabled) break
        if (entry.autoRounds < cfg.threshold) break
        if (entry.lastHandoffTurn !== null && entry.lastHandoffTurn === entry.lastTurnEnd.turn) break
        // Deterministic in-flight tool check, independent of the turn invariant.
        if (entry.inFlightTools.size > 0) {
          log('warn', `handoff skipped: ${entry.inFlightTools.size} unanswered tool call(s) at turn/end`)
          break
        }
        scheduleHandoff(session, entry)
        break
      }
      case 'tool/call': {
        const callId = callIdOf(data)
        if (callId !== undefined) entry.inFlightTools.set(String(callId), Number(event.seq) || 0)
        break
      }
      case 'tool/result': {
        const callId = callIdOf(data)
        if (callId !== undefined) entry.inFlightTools.delete(String(callId))
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/disposed', (agent) => {
    if (agent && agent.id) dropSessionState(agent.id)
  })
  ctx.on('session/disposed', (session) => {
    if (session && session.id) dropSessionState(session.id)
  })

  // Clear any pending deferred check on unload: a timer that outlives the
  // plugin would otherwise fire a handoff against a disposed context.
  ctx.effect(() => () => {
    for (const id of [...sessions.keys()]) dropSessionState(id)
  }, 'dsh-hint-handoff: pending handoff timers')

  // -------------------------------------------------------------------------
  // Serialisable state + HTTP routes for the browser half
  // -------------------------------------------------------------------------

  function snapshotFor(sessionId, modes) {
    const cfg = effectiveConfig()
    const sessionsSvc = service('sessions')
    let session = sessionsSvc && typeof sessionsSvc.get === 'function' && sessionId ? sessionsSvc.get(sessionId) : undefined
    let resolvedFrom = sessionId ? 'request' : 'none'
    // The Web client may not be able to name the session the user is looking at
    // (there is no host-side "current session" accessor on 0.1.7+, and the
    // client-side one depends on services this bundle must not require). When
    // the id is missing or unknown, fall back to the most recently seen live
    // session so the panel always has something real to show.
    if (!session) {
      const fallback = mostRecentSession()
      if (fallback) {
        session = fallback
        resolvedFrom = sessionId ? 'fallback-unknown-id' : 'fallback-latest'
      }
    }
    if (!session) return { ok: false, error: 'session-not-found', sessionId: sessionId || null }
    const entry = stateOf(session)
    hydrate(session, entry)
    const report = safetyReport(session, entry)
    const context = contextState(session)
    return {
      ok: true,
      plugin: PLUGIN_NAME,
      version: HANDOFF_PART_VERSION,
      sessionId: session.id,
      resolvedFrom,
      cwd: (session.header && session.header.cwd) || null,
      config: {
        enabled: cfg.enabled,
        threshold: cfg.threshold,
        archive: cfg.archive,
        outputDir: cfg.outputDir,
        digestEnabled: cfg.digestEnabled,
        createNewSession: cfg.createNewSession,
      },
      compactions: {
        auto: entry.autoRounds,
        manual: entry.manualRounds,
        failed: entry.failedRounds,
        inFlight: entry.openCompactions > 0,
        threshold: cfg.threshold,
      },
      // Merge addition: what the dialog's status line renders. `lastAt` is the
      // last SUCCESSFUL automatic trigger, so 「已触发（HH:MM）」 stays truthful
      // after the user reloads or the `ready` payload was consumed.
      autoHandoff: {
        enabled: cfg.enabled,
        lastAt: lastAutoHandoffAt || entry.lastAutoAt || null,
      },
      // Merge addition: the real mode catalog for the 交接会话 picker.
      modes: Array.isArray(modes) && modes.length > 0 ? modes : AGENT_MODE_ROWS.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        available: row.id === 'standard',
        presetId: null,
        fullAccess: true,
        permissionPreset: FULL_ACCESS_PRESET,
      })),
      turn: entry.lastTurnEnd,
      agentStatus: report.agent ? report.agent.status : null,
      inFlightTools: entry.inFlightTools.size,
      safe: report.safe,
      blockReasons: report.reasons,
      pending: entry.pending,
      lastHandoffTurn: entry.lastHandoffTurn,
      lastError: entry.lastError,
      ready: entry.ready && !entry.ready.consumed ? entry.ready : null,
      context,
      ts: Date.now(),
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  /**
   * The live session this plugin has seen most recently, used only as a
   * display fallback for the panel. `lastEventAt` is refreshed by the
   * `session/event` listener, so it tracks real activity rather than creation.
   */
  function mostRecentSession() {
    const sessionsSvc = service('sessions')
    if (!sessionsSvc || typeof sessionsSvc.list !== 'function') return undefined
    let best
    let bestAt = -1
    try {
      for (const session of sessionsSvc.list()) {
        if (!session || !session.id) continue
        const entry = sessions.get(session.id)
        const at = entry && entry.lastEventAt ? entry.lastEventAt : 0
        if (at > bestAt) {
          bestAt = at
          best = session
        }
      }
    } catch {
      return undefined
    }
    return best
  }

  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const parsed = JSON.parse(raw || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * `POST /handoff/config` — the settings panel's write path.
   *
   * Body: any subset of the editable keys, e.g. `{ threshold: 4, archive: false }`.
   * Returns the effective configuration after the write. Only the plugin's own
   * override file is touched; the profile stays read-only for this plugin.
   */
  const configHandler = async (req, res) => {
    try {
      const body = await readBody(req)
      const patch = {}
      for (const key of OVERRIDE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
      }
      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { ok: false, error: 'no-editable-keys', editable: OVERRIDE_KEYS })
        return
      }
      const written = writeOverrides(patch)
      if (!written.ok) {
        sendJson(res, 500, { ok: false, error: written.reason })
        return
      }
      sendJson(res, 200, {
        ok: true,
        file: written.file,
        overrides: written.overrides,
        config: effectiveConfig(),
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const stateHandler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      // Merge addition: the dialog renders the real mode catalog from here.
      let modes = null
      try {
        modes = await listAgentModes()
      } catch {
        modes = null
      }
      sendJson(res, 200, snapshotFor(url.searchParams.get('sessionId'), modes))
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const prepareHandler = async (req, res) => {
    try {
      const body = await readBody(req)
      const sessionsSvc = service('sessions')
      let session = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(body.sessionId) : undefined
      // Merge addition: the 提示交接 dialog does not know the current Session id
      // (the shell exposes no stable "current session" accessor), so it posts no
      // id and the host resolves the most recently active Session — the same
      // fallback GET /handoff/state already documents.
      if (!session) session = mostRecentSession()
      if (!session) {
        sendJson(res, 404, { ok: false, error: 'session-not-found' })
        return
      }
      // Merge addition: the dialog asks for a mode BEFORE handing off.
      const resolvedMode = await resolveHandoffMode(body.mode)
      const entry = stateOf(session)
      hydrate(session, entry)
      if (body.force === true) {
        entry.lastTurnEnd = entry.lastTurnEnd || { turn: 0, seq: -1, reason: 'completed' }
        // The dialog may post a custom instruction; honour it so the typed
        // wording really does replace the built-in standby instruction.
        const typed = typeof body.instruction === 'string' ? body.instruction.trim() : ''
        const options = {
          force: true,
          mode: resolvedMode.mode.id,
          agentPreset: resolvedMode.mode.presetId,
        }
        if (typed) options.instruction = typed
        const result = await runHandoff(session, entry, 'manual', options)
        if (result && typeof result === 'object') {
          result.mode = resolvedMode.mode.id
          result.modeRequested = resolvedMode.requested
          result.modeFellBack = resolvedMode.fellBack
          result.fullAccess = true
          result.permissionPreset = FULL_ACCESS_PRESET
        }
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }
      const report = safetyReport(session, entry)
      if (!report.safe) {
        sendJson(res, 409, { ok: false, error: 'unsafe', reasons: report.reasons, modes: await listAgentModes() })
        return
      }
      const result = await runHandoff(session, entry, 'http', {
        mode: resolvedMode.mode.id,
        agentPreset: resolvedMode.mode.presetId,
      })
      sendJson(res, result.ok ? 200 : 500, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const consumeHandler = async (req, res) => {
    try {
      const body = await readBody(req)
      const sessionsSvc = service('sessions')
      const session = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(body.sessionId) : undefined
      if (session) {
        const entry = stateOf(session)
        if (entry.ready) entry.ready = { ...entry.ready, consumed: true }
        entry.pending = false
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  const markdownHandler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const file = url.searchParams.get('file')
      if (!file || !isAbsolute(file)) {
        sendJson(res, 400, { ok: false, error: 'absolute-file-required' })
        return
      }
      if (!existsSync(file)) {
        sendJson(res, 404, { ok: false, error: 'not-found' })
        return
      }
      const text = readFileSync(file, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(text)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const disposers = [
        hostCtx.webServer.register({ kind: 'exact', path: '/handoff/state', handler: stateHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/handoff/prepare', handler: prepareHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/handoff/consume', handler: consumeHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/handoff/markdown', handler: markdownHandler }),
        hostCtx.webServer.register({ kind: 'exact', path: '/handoff/config', handler: configHandler }),
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
    }, 'dsh-hint-handoff: host routes')
  })

  // The Settings namespace is registered once by the merged `lib/index.js`
  // (single `hint-handoff` namespace). This module deliberately owns no
  // `Config` export and no settings registration.

  // -------------------------------------------------------------------------
  // Agent tool: let the model hand off on purpose
  // -------------------------------------------------------------------------

  ctx.inject(['tools'], (toolCtx) => {
    try {
      const dispose = toolCtx.tools.register({
        name: 'handoff_now',
        description:
          'Hand the current work over to a brand-new session: write a Markdown handoff document (what was done, ' +
          'what is next, paths, conventions), archive this session log, then open a new session in the same ' +
          'working directory and send it the instruction to read that document, understand the state, and stand ' +
          'by for the user. The new session does NOT resume work on its own. Use this when the ' +
          'user asks to hand off, to start fresh, or to continue in a new session.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reason: {
              type: 'string',
              description: 'Why the handoff is being requested; recorded in the plugin log and the document header.',
            },
          },
        },
        output: {
          schema: { type: 'object' },
          render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        async execute(args, exec) {
          const agent = exec && exec.agent ? exec.agent : undefined
          const sessionsSvc = service('sessions')
          const session =
            (agent && agent.session) ||
            (sessionsSvc && typeof sessionsSvc.get === 'function' && agent ? sessionsSvc.get(agent.id) : undefined)
          if (!session) return { ok: false, error: 'no-session' }
          const entry = stateOf(session)
          hydrate(session, entry)
          const result = await runHandoff(session, entry, `tool:${(args && args.reason) || 'unspecified'}`, { force: true })
          return result.ok
            ? {
                ok: true,
                handoffFile: result.handoffFile,
                cwd: result.cwd,
                archive: result.archive && result.archive.ok ? result.archive.dir : null,
                next:
                  'Tell the user to open a new session (or use the panel); the new session must read ' + result.handoffFile,
              }
            : { ok: false, error: result.error, reasons: result.reasons || null }
        },
      })
      toolCtx.effect(() => () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }, 'dsh-hint-handoff: handoff_now tool')
    } catch (error) {
      log('warn', `handoff_now tool unavailable: ${error && error.message ? error.message : String(error)}`)
    }
  })

  log(
    'info',
    `loaded (threshold=${boot.threshold}, archive=${boot.archive}, outputDir=${boot.outputDir}); ` +
      'waiting for completed turns with enough compaction rounds',
  )
}
