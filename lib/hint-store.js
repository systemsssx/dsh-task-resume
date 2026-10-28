/**
 * dsh-hint-ball — hint store (host half of the plugin, dependency-free).
 *
 * This module owns every piece of hint *data*: normalisation, the ring buffer,
 * the unread accounting, the read/clear operations and the optional seed /
 * persistence file formats. It has no cordis, fs or http dependency so it can be
 * unit-tested directly, and `lib/index.js` only wires it to the host services.
 *
 * A hint record is always:
 *   { id, title, body, level: 'info'|'warn'|'error', ts, source, read }
 */

export const LEVELS = Object.freeze(['info', 'warn', 'error'])
export const DEFAULT_LEVEL = 'info'

/** Accepted spellings (English + Chinese) for each level. */
const LEVEL_ALIASES = Object.freeze({
  info: 'info',
  information: 'info',
  notice: 'info',
  note: 'info',
  tip: 'info',
  提示: 'info',
  信息: 'info',
  通知: 'info',
  warn: 'warn',
  warning: 'warn',
  caution: 'warn',
  警告: 'warn',
  注意: 'warn',
  error: 'error',
  err: 'error',
  danger: 'error',
  critical: 'error',
  fatal: 'error',
  错误: 'error',
  异常: 'error',
  失败: 'error',
})

export const TITLE_MAX = 160
export const BODY_MAX = 1200

/**
 * Map anything to one of the three levels. Unknown values fall back to `info`
 * instead of throwing: a malformed push must never take the routes down.
 *
 * @param {unknown} value
 * @returns {'info'|'warn'|'error'}
 */
export function normalizeLevel(value) {
  if (typeof value !== 'string') return DEFAULT_LEVEL
  const key = value.trim().toLowerCase().replace(/^[[(（【]\s*|\s*[\])）】]$/g, '')
  return LEVEL_ALIASES[key] || DEFAULT_LEVEL
}

/**
 * Coerce a value to trimmed text and hard-clamp it. `max` keeps a runaway agent
 * payload from blowing up the panel (or the persistence file).
 */
export function clampText(value, max = BODY_MAX) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : String(value)
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`
}

function safeNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Default id factory: time + counter, base36, collision-free within a process. */
function makeIdFactory() {
  let counter = 0
  return (ts) => {
    counter += 1
    return `hint-${Math.max(0, Math.round(ts)).toString(36)}-${counter.toString(36)}`
  }
}

/**
 * Build the store.
 *
 * @param {object} [options]
 * @param {number} [options.maxHints=50]  ring-buffer size, newest win.
 * @param {() => number} [options.now]    clock injection (tests).
 * @param {(ts:number) => string} [options.idFactory] id injection (tests).
 */
export function createHintStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const nextId = typeof options.idFactory === 'function' ? options.idFactory : makeIdFactory()
  let maxHints = clampMaxHints(options.maxHints)

  /** @type {Array<object>} insertion order: oldest first, newest last. */
  let records = []

  function clampMaxHintsValue(value) {
    const n = safeNumber(value)
    if (n === null) return maxHints
    return Math.max(1, Math.min(500, Math.round(n)))
  }

  function trim() {
    if (records.length > maxHints) records = records.slice(records.length - maxHints)
  }

  /**
   * Turn one arbitrary push payload into a record, or `null` when it carries no
   * usable title/body at all.
   *
   * `title` may be omitted when `body` is present: the first body line is then
   * promoted to the title, which makes `post_hint({ body })` behave sanely.
   */
  function normalizeInput(input, source = 'unknown') {
    const raw = input && typeof input === 'object' ? input : { title: input }
    let title = clampText(raw.title ?? raw.name ?? raw.subject ?? '', TITLE_MAX)
    let body = clampText(raw.body ?? raw.text ?? raw.message ?? raw.detail ?? '', BODY_MAX)
    if (!title && !body) return null
    if (!title) {
      const firstBreak = body.indexOf('\n')
      title = firstBreak === -1 ? body : body.slice(0, firstBreak)
      title = clampText(title, TITLE_MAX)
      body = firstBreak === -1 ? '' : body.slice(firstBreak + 1).trim()
      if (!title) return null
    }
    const ts = safeNumber(raw.ts) ?? now()
    const record = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : nextId(ts),
      title,
      body,
      level: normalizeLevel(raw.level ?? raw.severity),
      ts,
      source: clampText(raw.source ?? source, 40) || 'unknown',
      read: raw.read === true,
    }
    return record
  }

  function push(input, opts = {}) {
    const record = normalizeInput(input, opts.source)
    if (!record) return null
    records.push(record)
    trim()
    return { ...record }
  }

  function pushMany(inputs, opts = {}) {
    const list = Array.isArray(inputs) ? inputs : [inputs]
    const added = []
    for (const input of list) {
      const record = push(input, opts)
      if (record) added.push(record)
    }
    return added
  }

  /** Newest first. `since` filters by `ts >= since`, `limit` caps the count. */
  function list(query = {}) {
    const since = safeNumber(query.since)
    const limit = safeNumber(query.limit)
    let rows = records.slice().reverse()
    if (since !== null) rows = rows.filter((row) => row.ts >= since)
    if (limit !== null && limit >= 0) rows = rows.slice(0, Math.round(limit))
    return rows.map((row) => ({ ...row }))
  }

  function snapshot() {
    return list()
  }

  function get(id) {
    const row = records.find((candidate) => candidate.id === id)
    return row ? { ...row } : null
  }

  /**
   * Mark hints read. `all: true` marks everything; otherwise only the listed
   * ids. Returns how many records actually changed.
   */
  function markRead(query = {}) {
    const all = query.all === true
    const ids = Array.isArray(query.ids) ? new Set(query.ids.filter((id) => typeof id === 'string')) : null
    if (!all && (!ids || ids.size === 0)) return 0
    let changed = 0
    for (const row of records) {
      if (row.read) continue
      if (all || ids.has(row.id)) {
        row.read = true
        changed += 1
      }
    }
    return changed
  }

  /** Remove hints; `onlyRead: true` keeps the unread ones. */
  function clear(query = {}) {
    const onlyRead = query.onlyRead === true
    const before = records.length
    records = onlyRead ? records.filter((row) => !row.read) : []
    return before - records.length
  }

  /** Replace the whole buffer (persistence restore / seed reload). */
  function replaceAll(inputs, opts = {}) {
    records = []
    return pushMany(inputs, opts)
  }

  function stats() {
    const byLevel = { info: 0, warn: 0, error: 0 }
    let unread = 0
    let unreadError = 0
    for (const row of records) {
      byLevel[row.level] = (byLevel[row.level] || 0) + 1
      if (!row.read) {
        unread += 1
        if (row.level === 'error') unreadError += 1
      }
    }
    return { total: records.length, unread, unreadError, byLevel, maxHints }
  }

  function setMaxHints(value) {
    maxHints = clampMaxHintsValue(value)
    trim()
    return maxHints
  }

  return {
    push,
    pushMany,
    list,
    snapshot,
    get,
    markRead,
    clear,
    replaceAll,
    stats,
    setMaxHints,
    get maxHints() {
      return maxHints
    },
  }
}

function clampMaxHints(value) {
  const n = safeNumber(value)
  if (n === null) return 50
  return Math.max(1, Math.min(500, Math.round(n)))
}

// ---------------------------------------------------------------------------
// Seed files: hints.json / HINTS.md
// ---------------------------------------------------------------------------

/**
 * Parse a `hints.json` payload. Accepts a bare array, `{ hints: [...] }` or a
 * single hint object; anything else yields an empty list.
 */
export function parseHintsJson(text) {
  let data = null
  try {
    data = JSON.parse(String(text || ''))
  } catch {
    return []
  }
  if (Array.isArray(data)) return data.filter((row) => row && typeof row === 'object')
  if (data && typeof data === 'object') {
    if (Array.isArray(data.hints)) return data.hints.filter((row) => row && typeof row === 'object')
    if (Array.isArray(data.items)) return data.items.filter((row) => row && typeof row === 'object')
    return [data]
  }
  return []
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/
const BULLET_RE = /^[ \t]*[-*+][ \t]+(.*)$/
const LIST_ITEM_RE = /^[ \t]*\d+[.)][ \t]+(.*)$/
/** `[warn]`, `(错误)`, `【error】` … at the start of a heading/bullet. */
const LEVEL_TAG_RE = /^[[(（【]\s*([A-Za-z\u4e00-\u9fa5]+)\s*[\])）】]\s*/

function splitLevelTag(text) {
  const match = LEVEL_TAG_RE.exec(text)
  if (!match) return { level: null, text }
  const level = LEADING_LEVELS[match[1].toLowerCase()] || null
  if (!level) return { level: null, text }
  return { level, text: text.slice(match[0].length).trim() }
}

const LEADING_LEVELS = Object.freeze({
  info: 'info',
  tip: 'info',
  note: 'info',
  warn: 'warn',
  warning: 'warn',
  警告: 'warn',
  error: 'error',
  err: 'error',
  错误: 'error',
})

/**
 * Parse a Markdown hint file.
 *
 * Two shapes are understood, and headings win when both appear:
 *   1. headings — `## [warn] 标题` with the following lines as the body;
 *   2. bullets  — `- [error] 标题 | 正文` (only used when there is no heading).
 */
export function parseHintsMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING_RE.exec(lines[index])
    if (match) headings.push({ index, raw: match[2].trim() })
  }

  const out = []
  if (headings.length > 0) {
    for (let position = 0; position < headings.length; position += 1) {
      const current = headings[position]
      const nextIndex = position + 1 < headings.length ? headings[position + 1].index : lines.length
      const { level, text: title } = splitLevelTag(current.raw)
      const body = lines
        .slice(current.index + 1, nextIndex)
        .join('\n')
        .trim()
      if (!title) continue
      out.push({ title, body, level: level || DEFAULT_LEVEL })
    }
    return out
  }

  for (const line of lines) {
    const match = BULLET_RE.exec(line) || LIST_ITEM_RE.exec(line)
    if (!match) continue
    const { level, text } = splitLevelTag(match[1].trim())
    if (!text) continue
    const separator = text.indexOf('|')
    const title = separator === -1 ? text : text.slice(0, separator).trim()
    const body = separator === -1 ? '' : text.slice(separator + 1).trim()
    if (!title) continue
    out.push({ title, body, level: level || DEFAULT_LEVEL })
  }
  return out
}

/** Pick the parser from the file name, falling back to "looks like JSON". */
export function parseSeed(text, filename = '') {
  const name = String(filename || '').toLowerCase()
  if (name.endsWith('.json')) return parseHintsJson(text)
  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) return parseHintsMarkdown(text)
  const head = String(text || '').trimStart()
  return head.startsWith('[') || head.startsWith('{') ? parseHintsJson(text) : parseHintsMarkdown(text)
}

// ---------------------------------------------------------------------------
// Persistence file format
// ---------------------------------------------------------------------------

export const STORE_VERSION = 1

/** Serialise the whole buffer, read flags included. */
export function serializeStore(records, now = Date.now()) {
  const hints = (Array.isArray(records) ? records : []).map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    level: normalizeLevel(row.level),
    ts: safeNumber(row.ts) ?? now,
    source: row.source,
    read: row.read === true,
  }))
  return `${JSON.stringify({ version: STORE_VERSION, savedAt: now, hints }, null, 2)}\n`
}

/** Read a persistence file back. Tolerates a bare array from older hands. */
export function deserializeStore(text) {
  let data = null
  try {
    data = JSON.parse(String(text || ''))
  } catch {
    return []
  }
  if (Array.isArray(data)) return data.filter((row) => row && typeof row === 'object')
  if (data && typeof data === 'object' && Array.isArray(data.hints)) {
    return data.hints.filter((row) => row && typeof row === 'object')
  }
  return []
}
