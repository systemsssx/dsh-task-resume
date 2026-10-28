/**
 * Pure helpers for dsh-auto-handoff: text/token/dump formatting with no Cordis
 * or filesystem state, so they can be unit-tested directly.
 */

/** Zero-pad to two digits. */
export function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Flatten a DSH content-block list (or a raw string) into plain text. */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block == null) continue
      if (typeof block === 'string') parts.push(block)
      else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }
  return ''
}

/** `20261006-024728` in local time: filesystem-safe and sortable. */
export function stamp(date = new Date()) {
  return (
    String(date.getFullYear()) +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    '-' +
    pad2(date.getHours()) +
    pad2(date.getMinutes()) +
    pad2(date.getSeconds())
  )
}

/** ISO-8601 with the local UTC offset. */
export function isoLocal(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    String(date.getFullYear()) +
    '-' + pad2(date.getMonth() + 1) +
    '-' + pad2(date.getDate()) +
    'T' + pad2(date.getHours()) +
    ':' + pad2(date.getMinutes()) +
    ':' + pad2(date.getSeconds()) +
    sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
  )
}

/** One JSON line per event so the archive replays with plain tooling. */
export function jsonlOf(events) {
  const lines = []
  for (const event of events) {
    try {
      lines.push(JSON.stringify(event))
    } catch {
      /* a non-JSON payload is skipped rather than aborting the archive */
    }
  }
  return lines.join('\n') + '\n'
}

/** Trim text to a rough token budget (4 characters per token heuristic). */
export function clampChars(text, maxTokens) {
  const limit = Math.max(256, Number(maxTokens) || 256) * 4
  if (text.length <= limit) return text
  return text.slice(0, limit) + '\n\n…（摘要已截断）'
}

// ---------------------------------------------------------------------------
// Continuation-session title
// ---------------------------------------------------------------------------

/**
 * Longest title handed to `sessionController.rename()`. The session list shows
 * the title as one row label, so a short "what is this about" beats a long line.
 * Chinese characters count as one character each.
 */
export const TITLE_MAX = 20

/** The heading of the section the title is read from. */
const TITLE_SECTION = '任务目标'

/** Markdown decoration used by the handoff document, stripped before titling. */
function stripDecoration(line) {
  return String(line == null ? '' : line)
    .replace(/^\s*#{1,6}\s*/, '') // heading markers
    .replace(/^\s*>+\s*/, '') // blockquote markers
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)、]|[一二三四五六七八九十]{1,3}[、.)])\s*/, '') // list numbering
    .replace(/[*_`~]/g, '') // emphasis / code marks
    .replace(/\s+/g, ' ') // collapse runs of whitespace
    .trim()
}

/** A line that annotates the document instead of describing the task. */
function isNoise(text) {
  if (!text) return true
  if (/^(无|没有|暂无|未知|none|null|n\/?a)\.?$/i.test(text)) return true // digest's empty marker
  if (/^[（(].*[）)]$/.test(text)) return true // parenthesised aside, e.g. the placeholder
  if (text.includes('自动摘要不可用')) return true // the fallback warning
  if (/^[#>*`~\-_=+]{2,}$/.test(text)) return true // horizontal rules / code fences
  return false
}

/** `用户目标与当前进度：xxx` → `xxx`; also drops stray leading colons. */
const SECTION_LABEL =
  /^[^：:]{1,14}(?:目标|进度|工作|事项|计划|约定|风险|结论|背景|需求|问题|要点|说明|任务|路径|命令|状态|上下文)[：:]\s*(\S.*)$/

function dropLabel(text) {
  const match = SECTION_LABEL.exec(text)
  if (match) return match[1].trim()
  return text.replace(/^[：:\-–—·、,，.。\s]+/, '').trim()
}

/**
 * The title is a row label, never a ritual: the old `交接 · <short code>` form
 * is forbidden, so any 交接/交接班 token is removed and the residue tidied.
 */
function dropHandoffWord(text) {
  return text
    .replace(/交接(?:班)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·、,，。；;：:\-–—]+/, '')
    .replace(/[\s·、,，。；;：:\-–—（(《<「『【[{]+$/, '')
    .trim()
}

/** Prefer a complete clause when the line is longer than the budget. */
function cutAtSentence(text) {
  const match = /^(.{8,}?)[。；;！!？?]/.exec(text)
  if (!match) return ''
  const clause = match[1].trim()
  return clause.length >= 8 && clause.length <= TITLE_MAX ? clause : ''
}

/**
 * Truncate to `TITLE_MAX` characters. Truncation with an ellipsis: the first
 * `TITLE_MAX - 1` characters plus `…`, so the result is never longer than 20
 * (trailing punctuation, spaces and half-open brackets are dropped first).
 */
export function clampTitle(text) {
  const raw = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。；;！!？?]+$/, '')
  if (raw.length <= TITLE_MAX) return raw
  const clause = cutAtSentence(raw)
  if (clause) return clause
  const cut = raw.slice(0, TITLE_MAX - 1)
  // Never leave a half-open bracket dangling: cut back to before it.
  const balanced = cut.replace(/[（(《<「『【[{][^）)》>」』】\]}]*$/, '')
  const head = (balanced.length >= 6 ? balanced : cut).replace(/[\s·、,，。；;：:\-–—（(《<「『【[{]+$/, '')
  return (head.length > 0 ? head : cut) + '…'
}

/** The body lines of the `## … 任务目标 …` section; empty when it is absent. */
function sectionLines(markdown, keyword) {
  const lines = String(markdown == null ? '' : markdown).split(/\r?\n/)
  const body = []
  let inside = false
  for (const line of lines) {
    const heading = /^\s*#{1,6}\s*(.*?)\s*$/.exec(line)
    if (heading) {
      if (inside) break // the next heading ends the section
      inside = heading[1].includes(keyword)
      continue
    }
    if (inside) body.push(line)
  }
  return body
}

/** The previous title is unusable when it is just a short code (or empty). */
function sanitisePreviousTitle(previousTitle) {
  let text = dropHandoffWord(dropLabel(stripDecoration(previousTitle)))
  if (text.length < 2) return ''
  if (/^[0-9a-zA-Z_-]{1,12}$/.test(text)) return '' // looks like a session short code
  if (/^(?:session-)?[0-9a-f]{6,}$/i.test(text)) return '' // `session-a0cf8062`, or the bare short code
  return text
}

/**
 * A title that is only the head of the session's FIRST user message is an
 * auto-title of stale text, not a description of the current work. The degraded
 * path must not resurface it: that is exactly the bug where a long session's
 * continuation was named after the very first thing the user ever typed.
 */
function isStaleFirstMessageTitle(title, firstUserText) {
  const first = stripDecoration(firstUserText).replace(/\s+/g, '')
  if (first.length < 4) return false
  const bare = stripDecoration(title).replace(/[\s.…。]+$/, '').replace(/\s+/g, '')
  if (bare.length < 4) return false
  return first.startsWith(bare)
}

/**
 * The digest section is DEGRADED when the model summary was not available
 * (`digest_source: empty|failed|disabled|unavailable`): `renderHandoff()` then
 * writes the 「自动摘要不可用」 warning plus the deterministic facts instead of a
 * summary, and section 1 says nothing about the current task.
 */
function isDegradedDigest(markdown) {
  return String(markdown == null ? '' : markdown).includes('自动摘要不可用')
}

/**
 * A raw session id (`a0cf8062`, `session-a0cf8062-1936-43ea-83eb-c1c11eaef2b8`)
 * is never a row label: the user cannot tell one id from another at a glance.
 */
const SESSION_SHORT_CODE = /^(?:session-)?[0-9a-f]{8}(?:-?[0-9a-f]{4})*$/i

/**
 * Derive the continuation-session title from the handoff content.
 *
 * Order:
 *   1. the first meaningful line of `## 1. 任务目标与当前进度` (markdown marks,
 *      list numbering and a `用户目标：`-style label stripped);
 *   2. DEGRADED section only — the original session's own current title, which
 *      describes the work better than anything the old transcript starts with
 *      (refused when it is just an auto-title of the first user message);
 *   3. the MOST RECENT user message of the original session: in a long session
 *      that is the work in progress, while the first message is history;
 *   4. the first user message — the last source before giving up;
 *   5. `续作 · <原会话标题>` (truncated), or plain `续作` when it is unavailable.
 *
 * Every path returns at most `TITLE_MAX` characters, drops the 交接 token and
 * refuses a bare session short code, so the old `交接 · <short code>` form can
 * never come back. Pure, so the strategy is unit-testable.
 */
export function titleFromHandoff(markdown, options = {}) {
  const firstUserText = options.firstUserText == null ? '' : String(options.firstUserText)
  const recentUserText = options.recentUserText == null ? '' : String(options.recentUserText)
  const previousTitle = options.previousTitle == null ? '' : String(options.previousTitle)
  const degraded = options.degraded === true || isDegradedDigest(markdown)
  const firstMeaningful = (text) => {
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
      const plain = stripDecoration(line)
      if (isNoise(plain)) continue
      return dropLabel(plain)
    }
    return ''
  }
  /**
   * A candidate is usable once it still says something after the 交接 cleanup,
   * is not a raw session id, and fits the row label budget.
   */
  const usable = (text) => {
    const cleaned = dropHandoffWord(text || '')
    if (cleaned.length < 2 || SESSION_SHORT_CODE.test(cleaned)) return ''
    return clampTitle(cleaned)
  }

  const fromSection = usable(firstMeaningful(sectionLines(markdown, TITLE_SECTION).join('\n')))
  if (fromSection) return fromSection

  const previous = sanitisePreviousTitle(previousTitle)
  if (degraded && previous && !isStaleFirstMessageTitle(previous, firstUserText)) return clampTitle(previous)

  const fromRecent = usable(firstMeaningful(recentUserText))
  if (fromRecent) return fromRecent

  const fromFirst = usable(firstMeaningful(firstUserText))
  if (fromFirst) return fromFirst

  return previous ? clampTitle(`续作 · ${previous}`) : '续作'
}

/**
 * Render the handoff Markdown. Kept pure so the document layout is testable
 * without a live session.
 */
export function renderHandoff(facts) {
  const {
    now,
    session,
    cwd,
    outputDir,
    autoRounds,
    manualRounds,
    threshold,
    lastTurn,
    agentStatus,
    route,
    context,
    digest,
    files,
    archiveDir,
    fallbackText,
  } = facts
  const lines = []
  lines.push('# 会话交接记录（DSH auto-handoff）')
  lines.push('')
  lines.push('> 本文件由 `dsh-auto-handoff` 插件自动生成，用于**把一个会话的任务状态交接给一个全新的 DSH 会话**。')
  lines.push('> 新会话第一步：完整读取本文件、理解任务目标与进度，然后**停在这里待命**，等用户给出下一步指示。')
  lines.push('')
  lines.push('## 0. 机器可读头')
  lines.push('')
  lines.push('```yaml')
  lines.push('generator: dsh-auto-handoff')
  lines.push(`handoff_at: ${isoLocal(now)}`)
  lines.push(`from_session: ${session}`)
  lines.push(`workspace: ${cwd}`)
  lines.push(`output_dir: ${outputDir}`)
  lines.push(`compaction_rounds_auto: ${autoRounds}`)
  lines.push(`compaction_rounds_manual: ${manualRounds}`)
  lines.push(`threshold: ${threshold}`)
  lines.push(`last_completed_turn: ${lastTurn == null ? 'null' : lastTurn}`)
  lines.push(`agent_status_at_write: ${agentStatus || 'unknown'}`)
  lines.push(`route: ${route || 'unknown'}`)
  lines.push(`context_tokens: ${context && context.usedTokens != null ? context.usedTokens : 'null'}`)
  lines.push(`context_window: ${context && context.contextWindow != null ? context.contextWindow : 'null'}`)
  lines.push(`digest_source: ${digest && digest.source ? digest.source : 'unknown'}`)
  lines.push('```')
  lines.push('')
  lines.push('## 1. 任务目标与当前进度')
  lines.push('')
  const body = digest && digest.text ? String(digest.text).trim() : ''
  if (body) lines.push(body)
  else {
    lines.push('> ⚠️ 自动摘要不可用，以下是可确定的事实（请结合归档的完整会话日志自行判断）。')
    lines.push('')
    lines.push(fallbackText ? String(fallbackText).slice(0, 4000) : '（本会话没有可迁移的助手输出）')
  }
  lines.push('')
  if (Array.isArray(files) && files.length > 0) {
    lines.push('## 2. 本会话改动过的文件（来自工作区变更记录）')
    lines.push('')
    for (const file of files) lines.push(`- \`${file}\``)
    lines.push('')
  }
  lines.push('## 3. 交接后的待命约定')
  lines.push('')
  lines.push('- 本文件是「交接说明」，不是待办清单的执行指令：读取并理解即可；')
  lines.push('- 读完请**停在这里待命**：不要开始任何新的操作、不要修改任何文件、不要调用工具；')
  lines.push('- 上面的「任务目标与当前进度」是给用户下一步指示做参考的，不要自行接着做；')
  lines.push(`- 等用户给出指示后再行动。如需历史细节，见归档：\`${archiveDir || outputDir}\`。`)
  lines.push('')
  lines.push('## 4. 硬性约定')
  lines.push('')
  lines.push(`- 工作目录（cwd）：\`${cwd}\`（必须与原会话一致）`)
  lines.push('- 不要在本文件里写代码；它是交接说明，不是产出物。')
  lines.push('')
  return lines.join('\n')
}
