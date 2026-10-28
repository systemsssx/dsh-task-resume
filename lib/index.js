/**
 * dsh-hint-handoff — host entry.
 *
 * Merge of two local DSH plugins, keeping BOTH host feature sets:
 *   - `dsh-hint-ball` 0.1.0  → hint list + `post_hint` tool + `/hint/*` routes
 *                              (`lib/hints.js`, `lib/hint-store.js`);
 *   - `dsh-auto-handoff` 0.2.0 → compaction-round counting, automatic handoff,
 *                              `/handoff/*` routes, `handoff_now` tool
 *                              (`lib/handoff.js`, `lib/handoff-doc.js`).
 *
 * What this file adds on top of the two merged halves:
 *   - one Cordis plugin (`name` / `version` / `Config` / `apply`);
 *   - one Settings namespace, `hint-handoff`, over a combined schema;
 *   - the merge-level logging.
 *
 * The Config guard below is deliberate and copied from both originals: a
 * profile installs plugins as `link:`, so Node resolves `@deepseek-ai/schemastery`
 * from the plugin's REAL path and may not reach the DSH installation tree. In
 * that case exporting a hand-rolled stand-in schema breaks the row's config
 * validation and silently disables the whole plugin, so `Config` stays
 * `undefined` and every field is clamped at runtime instead.
 */
import { registerHints } from './hints.js'
import { registerHandoff } from './handoff.js'

export const name = 'dsh-hint-handoff'
export const version = '0.1.0'

let Config
/** True only when `Config` is a real schemastery schema (not the fallback). */
let configSchemaIsReal = false
try {
  const mod = await import('@deepseek-ai/schemastery')
  const z = mod.default ?? mod
  Config = z.object({
    // ── hint half (dsh-hint-ball) ──────────────────────────────────────────
    enabled: z.boolean().default(true),
    maxHints: z.number().min(1).max(500).default(50),
    pollMs: z.number().min(1000).max(60000).default(4000),
    autoOpenOnError: z.boolean().default(false),
    seedFile: z.string().default(''),
    persistPath: z.string().default(''),
    // ── handoff half (dsh-auto-handoff) ────────────────────────────────────
    // `threshold` is the number of completed AUTOMATIC compaction rounds that
    // triggers the automatic handoff. The merged default is 8 (the original
    // plugin defaulted to 1); the dialog renders the real value as x/y.
    threshold: z.number().min(1).max(100).default(8),
    instruction: z.string().default(''),
    archive: z.boolean().default(true),
    maxDigestTokens: z.number().min(256).max(32000).default(2048),
    keepHandoffs: z.number().min(1).max(500).default(20),
    outputDir: z.string().default('.dsh-handoff'),
    digestEnabled: z.boolean().default(true),
    settleDelayMs: z.number().min(0).max(10000).default(50),
    idleRetries: z.number().min(0).max(20).default(6),
    createNewSession: z.boolean().default(true),
  })
  configSchemaIsReal = true
} catch (error) {
  console.warn(
    '[dsh-hint-handoff] @deepseek-ai/schemastery not resolvable; exporting NO Config ' +
      '(settings card degrades, cordis.patch.yml configuration still works): ' +
      (error && error.message ? error.message : String(error)),
  )
  Config = undefined
}
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - boot-time config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-hint-handoff] ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  // The two halves own disjoint state, routes and tools; each one is defensive
  // on its own, so one failing to mount can never take the other down.
  try {
    registerHints(ctx, config)
  } catch (error) {
    log('error', `hint half failed to mount: ${error && error.message ? error.message : String(error)}`)
  }
  try {
    registerHandoff(ctx, config)
  } catch (error) {
    log('error', `handoff half failed to mount: ${error && error.message ? error.message : String(error)}`)
  }

  // One Settings namespace over the combined schema (best effort, same guard
  // both originals used: only a REAL schemastery schema is safe to export).
  if (Config && configSchemaIsReal) {
    ctx.inject(['settings'], (sctx) => {
      try {
        const scope = sctx.settings.register('hint-handoff', Config, { base: config })
        ctx.effect(() => () => {
          try {
            if (scope && typeof scope.dispose === 'function') scope.dispose()
          } catch {
            /* ignore */
          }
        }, 'dsh-hint-handoff: settings scope')
      } catch (error) {
        log('warn', `settings namespace unavailable: ${error && error.message ? error.message : String(error)}`)
      }
    })
  }

  log(
    'info',
    'loaded (hint routes GET/POST /hint/*, tools post_hint + handoff_now, ' +
      'handoff routes /handoff/*); automatic handoff waits for completed turns ' +
      `with threshold=${Number(config && config.threshold) || 1} compaction rounds`,
  )
}
