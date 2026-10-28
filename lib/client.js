// dsh-hint-handoff — browser half (提示交接).
//
// One sidebar entry + one dialog. The dialog has exactly two blocks:
//   1. 消息板块 — the hint list (host `GET /hint/list`, the merged
//      dsh-hint-ball message store), a scrollable list, with a quiet Chinese
//      empty state;
//   2. 交接按钮 — 「交接会话」; pressing it first reveals the mode picker
//      (Computer Use 模式 / 标准模式, both full access, each with the small
//      「完全权限」 note) and only then POSTs `/handoff/prepare {force:true,mode}`.
// Under the button sits one 12px secondary-text status line, rendered from the
// REAL host state: `压缩轮数 0/1 · 自动交接 已关闭` /
// `压缩轮数 1/1 · 自动交接 已触发（12:04）` / `… · 自动交接 未触发`.
// The dialog polls while open, so an automatic handoff updates that line
// without a page refresh.
//
// ENTRY POINT (sidebar): a row in the shell's native global-panel nav list
// (`nav [class*="_panelList"]`) — the 「插件 / 自动化任务 / 更多」 column —
// inserted immediately AFTER dsh-project-hub's own 「项目工坊」 row, and after
// any other plugin's `data-*-entry` row that already occupies that slot. It is
// a DOM CLONE of a native `button[class*="_panelRow"]`, so it keeps the native
// padding / gap / radius / hover highlight / focus ring. The insertion is
// idempotent (one node, re-validated on DOM mutations) and a conflict NEVER
// moves or overwrites another plugin's row: the scan walks DOWN past occupied
// entry rows until it finds a free seat. Unmount removes only our own nodes.
//
// IDS/CLASSES: every id, class and data-* attribute is prefixed `dhh-`
// (`data-dhh-entry`, `data-dhh-dialog`, `data-dhh-status`, `data-dhh-mode`, …),
// so nothing can collide with dsh-project-hub (`dsh-ph-*`,
// `data-project-hub-*`) or any other plugin.
//
// LOADING CONTRACT (same as the shipped plugins): the bundle is served as a
// CLASSIC script and must register with `window.__ModuleLoader__.load({id,
// factory})`. A renderer reload may execute the file before that facade is
// published, so the bootstrap below never throws: it registers immediately when
// the facade exists, otherwise polls (bounded, silent) and gives up quietly. No
// DOM code runs at the top level; the factory only touches the document when
// the module system calls it after boot.
;(function () {
  /** Client module id — must equal the package name / bundle client id. */
  const MODULE_ID = 'dsh-hint-handoff'
  /** Poll cadence while the loader facade is still missing (renderer reload). */
  const LOADER_POLL_INTERVAL_MS = 100
  /** Hard stop for the loader poll: silently give up after this budget. */
  const LOADER_POLL_BUDGET_MS = 10000

  /** The live `window.__ModuleLoader__` facade, or null (never throws). */
  function readModuleLoader() {
    try {
      if (typeof window === 'undefined' || window === null) return null
      const loader = window.__ModuleLoader__
      if (!loader || typeof loader.load !== 'function') return null
      return loader
    } catch {
      return null
    }
  }

  /**
   * Register this bundle with the client module system. Never throws: registers
   * right away when the facade exists, otherwise polls (100 ms, ≤ 10 s) and
   * stops silently at the deadline. Node stub tests rely on the timer being
   * `unref()`ed so evaluating the bundle cannot keep a test process alive.
   *
   * @param factory - the CJS-style client factory `(require) => module.exports`.
   */
  function bootstrapClientModule(factory) {
    let registered = false

    const registerOnce = () => {
      if (registered) return true
      const loader = readModuleLoader()
      if (!loader) return false
      registered = true
      try {
        loader.load({ id: MODULE_ID, factory })
      } catch {
        /* duplicate/rejected registration must never escape the bundle */
      }
      return true
    }

    if (registerOnce()) return
    if (typeof setTimeout !== 'function') return

    const schedule = (callback, delay) => {
      const timer = setTimeout(callback, delay)
      try {
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch {
        /* browsers return a number */
      }
      return timer
    }

    const startedAt = Date.now()
    const poll = () => {
      if (registerOnce()) return
      if (Date.now() - startedAt >= LOADER_POLL_BUDGET_MS) return
      schedule(poll, LOADER_POLL_INTERVAL_MS)
    }
    schedule(poll, LOADER_POLL_INTERVAL_MS)
  }

  const clientFactory = (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ═══════════════════════════════════════════════════════════════════════
    // Constants — every id / class / data attribute carries the `dhh-` prefix.
    // ═══════════════════════════════════════════════════════════════════════

    /** Portal host mounted on `document.body`; owns only this plugin's nodes. */
    const PORTAL_HOST_ID = 'dhh-portal-host'
    /** Injected stylesheet id. */
    const STYLE_ID = 'dhh-styles'
    const OVERLAY_ID = 'dhh-overlay'
    const DIALOG_ID = 'dhh-dialog'
    const CLOSE_ID = 'dhh-close'
    const MESSAGE_LIST_ID = 'dhh-message-list'
    const HANDOFF_BTN_ID = 'dhh-handoff-btn'
    const MODE_PICKER_ID = 'dhh-mode-picker'
    const STATUS_ID = 'dhh-status'
    const CANCEL_ID = 'dhh-cancel'

    const NAV_ROW_ID = 'dhh-nav-row'
    const NAV_ROW_CLASS = 'dhh-nav-row'
    const NAV_ROW_RAIL_CLASS = 'dhh-nav-row-rail'
    const NAV_ROW_FALLBACK_CLASS = 'dhh-nav-row-fallback'
    const NAV_GLYPH_CLASS = 'dhh-nav-glyph'
    const NAV_LABEL_CLASS = 'dhh-nav-label'

    const ENTRY_ATTR = 'data-dhh-entry'
    const OVERLAY_ATTR = 'data-dhh-overlay'
    const DIALOG_ATTR = 'data-dhh-dialog'
    const MESSAGES_ATTR = 'data-dhh-messages'
    const STATUS_ATTR = 'data-dhh-status'
    const MODE_ATTR = 'data-dhh-mode'

    /** Fired on `window` when the entry row is clicked (observability/testing). */
    const TOGGLE_EVENT = 'dsh-hint-handoff:toggle-dialog'
    /** Shell's own global-panel row label — our row goes right below it. */
    const MORE_LABEL = '更多'
    /** dsh-project-hub's visible row label (the row we want to follow). */
    const PROJECT_HUB_LABEL = '项目工坊'

    /** Entry copy + glyph (plain text, no colour emoji — 项目工坊 style). */
    const ENTRY_LABEL = '提示交接'
    const ENTRY_GLYPH = '◎'

    /** Fallback Host origin: the shipped desktop Web GUI listens here. */
    const DEFAULT_HOST_BASE = 'http://127.0.0.1:9760'
    /** Dialog refresh cadence; the status line must track automatic handoffs. */
    const DEFAULT_POLL_MS = 2000
    /** Never poll faster than 1 s / slower than 2 s from inside the dialog. */
    const MIN_POLL_MS = 1000
    const MAX_DIALOG_POLL_MS = 2000
    /** How long a handoff success/failure message owns the status line. */
    const STATUS_OVERRIDE_MS = 8000

    /** Fallback mode catalog (host `modes` always wins when it answers). */
    const FALLBACK_MODES = [
      {
        id: 'computer-use',
        name: 'Computer Use 模式',
        description: '桌面 GUI 操作',
        fullAccess: true,
      },
      {
        id: 'standard',
        name: '标准模式',
        description: '编码、文档、搜索与子代理',
        fullAccess: true,
      },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Module state (all lazy: nothing touches the DOM until apply/call time)
    // ═══════════════════════════════════════════════════════════════════════

    let disposed = false
    let overlayEl = null
    let dialogEl = null
    let messageListEl = null
    let handoffBtnEl = null
    let modePickerEl = null
    let cancelBtnEl = null
    let statusEl = null
    let els = null
    let navRow = null
    // Event-driven entry probe: NO high-frequency interval / rAF / self-loop.
    // `bodyObserver` merely asks "is our single node still in the document?"
    // (O(1)); `chromeObserver` watches the sidebar collapse attributes only.
    let bodyObserver = null
    let chromeObserver = null
    let mountTimer = null
    let seatTimer = null
    let pollTimer = null
    let pollMs = DEFAULT_POLL_MS
    let dialogOpen = false
    let modePickerOpen = false
    let busy = false
    let lastFocus = null
    let stateCache = null
    let hintsCache = []
    /** Signature of the currently rendered hint list (skip identical re-renders). */
    let messagesKey = ''
    let modesCache = []
    let modesKey = ''
    let statusOverride = null
    let bridgeProbe = null
    let bridgedHostBase = ''

    // ═══════════════════════════════════════════════════════════════════════
    // Host origin resolution + JSON requests
    // (desktop renders at `dsh-app://app/`, so relative routes alone are not
    // enough; same resolution order the shipped plugins use)
    // ═══════════════════════════════════════════════════════════════════════

    /** Keep only a real http(s) origin; `dsh-app://...` and junk become ''. */
    function normalizeHttpOrigin(value) {
      if (typeof value !== 'string' || value === '') return ''
      try {
        const url = new URL(value)
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
      } catch {
        /* not a URL */
      }
      return ''
    }

    function primeHostBaseFromBridge(scope) {
      const win = scope || (typeof window !== 'undefined' ? window : null)
      if (!win || !win.dshDesktopBoot || typeof win.dshDesktopBoot.ready !== 'function') {
        return Promise.resolve('')
      }
      if (bridgeProbe) return bridgeProbe
      bridgeProbe = Promise.resolve()
        .then(() => win.dshDesktopBoot.ready())
        .then((result) => {
          const origin = normalizeHttpOrigin(result && result.streamBaseUrl)
          if (origin) bridgedHostBase = origin
          return bridgedHostBase
        })
        .catch(() => {
          bridgeProbe = null
          return ''
        })
      return bridgeProbe
    }

    /**
     * Resolve the Host HTTP origin for this plugin's routes.
     * Order: `__DSH_TRANSPORT__.streamBaseUrl` → the desktop boot bridge →
     * `location.origin` (http runs) → `location.port` → the loopback default.
     */
    function resolveHostBase(scope) {
      const win = scope || (typeof window !== 'undefined' ? window : null)

      let transport = null
      try {
        transport = win && win.__DSH_TRANSPORT__ ? win.__DSH_TRANSPORT__ : null
      } catch {
        transport = null
      }
      if (!transport && typeof globalThis !== 'undefined') {
        try {
          transport = globalThis.__DSH_TRANSPORT__ || null
        } catch {
          transport = null
        }
      }
      if (transport && typeof transport.streamBaseUrl === 'string') {
        const origin = normalizeHttpOrigin(transport.streamBaseUrl)
        if (origin) return origin
      }

      if (bridgedHostBase) return bridgedHostBase

      let location = null
      try {
        location = (win && win.location) || null
      } catch {
        location = null
      }
      if (location) {
        const origin = normalizeHttpOrigin(
          typeof location.origin === 'string' && location.origin !== 'null'
            ? location.origin
            : location.protocol && location.host
              ? `${location.protocol}//${location.host}`
              : '',
        )
        if (origin) return origin
        const port = Number(location.port)
        if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
      }

      return DEFAULT_HOST_BASE
    }

    /** Absolute http(s) URL for one Host route; never a `dsh-app://` URL. */
    function buildApiUrl(base, path) {
      const cleanBase = String(base || DEFAULT_HOST_BASE).replace(/\/+$/, '')
      const cleanPath = '/' + String(path || '').replace(/^\/+/, '')
      if (!/^https?:\/\//i.test(cleanBase)) return cleanPath
      return cleanBase + cleanPath
    }

    function fetchImpl() {
      if (typeof window !== 'undefined' && window && typeof window.fetch === 'function') return window.fetch
      if (typeof fetch === 'function') return fetch
      return null
    }

    async function fetchJson(url, init) {
      const doFetch = fetchImpl()
      if (!doFetch) throw new Error('fetch unavailable')
      const res = await doFetch(url, init)
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      return { ok: res.ok, status: res.status, data }
    }

    /**
     * Call one Host JSON route. Primary transport is the absolute Host origin;
     * when the desktop page refuses it, fall back to the document-relative
     * route, which the shell's `dsh-app://` handler forwards to the same Host.
     */
    async function requestApi(path, options) {
      const config = options || {}
      const init = {
        method: config.method || 'GET',
        credentials: 'omit',
      }
      if (config.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(config.body)
      }

      let base = resolveHostBase()
      if (
        base === DEFAULT_HOST_BASE &&
        !bridgedHostBase &&
        typeof window !== 'undefined' &&
        window &&
        !window.__DSH_TRANSPORT__ &&
        window.dshDesktopBoot
      ) {
        const bridged = await primeHostBaseFromBridge()
        if (bridged) base = bridged
      }
      const target = buildApiUrl(base, path)
      let primaryError = null
      if (/^https?:\/\//i.test(target)) {
        try {
          return await fetchJson(target, init)
        } catch (error) {
          primaryError = error
        }
      }
      try {
        return await fetchJson(String(path).replace(/^\/+/, ''), init)
      } catch (error) {
        throw primaryError || error
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Styles — 100 % `--dsw-*` tokens, 项目工坊's dark rhythm. No bright blocks.
    // ═══════════════════════════════════════════════════════════════════════

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .dhh-overlay {
          position: fixed; inset: 0;
          background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55));
          z-index: 10020; display: flex; align-items: center; justify-content: center;
          padding: 24px; box-sizing: border-box;
          font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        }
        .dhh-dialog {
          width: 440px; max-width: min(480px, calc(100vw - 48px));
          max-height: min(560px, calc(100vh - 80px));
          display: flex; flex-direction: column;
          background: var(--dsw-alias-bg-layer-1, #1b1c21);
          border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
          border-radius: var(--dsw-radius-lg, 16px);
          box-shadow: var(--dsw-shadow-lv3, 0 24px 64px rgba(0, 0, 0, 0.55));
          color: var(--dsw-alias-label-primary, #ededed);
          overflow: hidden; box-sizing: border-box;
        }
        .dhh-dialog * { box-sizing: border-box; }
        .dhh-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 16px 8px;
        }
        .dhh-title { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; }
        .dhh-close {
          appearance: none; border: none; background: transparent;
          color: var(--dsw-alias-label-tertiary, #777a86);
          width: 26px; height: 26px; padding: 0; border-radius: var(--dsw-radius-sm, 8px);
          display: inline-flex; align-items: center; justify-content: center;
          font-family: inherit; font-size: 17px; line-height: 1; cursor: pointer;
        }
        .dhh-close:hover {
          color: var(--dsw-alias-label-primary, #ededed);
          background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
        }
        .dhh-messages {
          flex: 1 1 auto; min-height: 140px; max-height: 320px; overflow-y: auto;
          margin: 0 10px; padding: 2px 6px 10px;
          display: flex; flex-direction: column; gap: 2px;
        }
        .dhh-empty {
          padding: 34px 10px; text-align: center;
          font-size: 12px; line-height: 1.7;
          color: var(--dsw-alias-label-tertiary, #777a86);
        }
        .dhh-message {
          display: flex; align-items: flex-start; gap: 9px;
          padding: 9px 10px; border-radius: var(--dsw-radius-sm, 8px);
        }
        .dhh-message:hover {
          background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));
        }
        .dhh-message-dot {
          flex: none; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%;
          background: var(--dsw-alias-label-quaternary, #5b5e68);
        }
        .dhh-message.is-warn .dhh-message-dot {
          background: var(--dsw-alias-state-warn-primary, #f59e0b);
        }
        .dhh-message.is-error .dhh-message-dot {
          background: var(--dsw-alias-state-error-primary, #f0524f);
        }
        .dhh-message.is-read .dhh-message-dot {
          background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-label-quaternary, #5b5e68);
        }
        .dhh-message-main { flex: 1 1 auto; min-width: 0; }
        .dhh-message-line { display: flex; align-items: baseline; gap: 8px; }
        .dhh-message-title {
          font-size: 13px; font-weight: 500; line-height: 1.45;
          color: var(--dsw-alias-label-primary, #ededed);
          overflow-wrap: anywhere;
        }
        .dhh-message-time {
          flex: none; margin-left: auto; font-size: 11px;
          color: var(--dsw-alias-label-tertiary, #777a86);
        }
        .dhh-message-body {
          margin-top: 2px; font-size: 12px; line-height: 1.55;
          color: var(--dsw-alias-label-secondary, #9a9ca6);
          white-space: pre-wrap; overflow-wrap: anywhere;
        }
        .dhh-actions {
          flex: none; display: flex; flex-direction: column; gap: 10px;
          padding: 12px 16px 14px;
          border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
        }
        .dhh-primary {
          width: 100%; padding: 9px 14px;
          border-radius: var(--dsw-radius-sm, 8px);
          border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.2));
          background: var(--dsw-alias-bg-layer-3, #26282f);
          color: var(--dsw-alias-label-primary, #ededed);
          font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1.4;
          cursor: pointer;
          transition: background 0.16s ease, border-color 0.16s ease;
        }
        .dhh-primary:hover:not(:disabled) {
          background: var(--dsw-alias-bg-layer-4, #2e3038);
          border-color: var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.26));
        }
        .dhh-primary:disabled { opacity: 0.55; cursor: not-allowed; }
        .dhh-mode-picker { display: flex; flex-direction: column; gap: 8px; }
        .dhh-mode {
          display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
          width: 100%; padding: 10px 12px; text-align: left;
          border-radius: var(--dsw-radius-sm, 8px);
          border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
          background: var(--dsw-alias-bg-base, #111215);
          color: var(--dsw-alias-label-primary, #ededed);
          font-family: inherit; cursor: pointer;
          transition: background 0.16s ease, border-color 0.16s ease;
        }
        .dhh-mode:hover:not(:disabled) {
          background: var(--dsw-alias-bg-layer-2, #23252d);
          border-color: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.2));
        }
        .dhh-mode:disabled { opacity: 0.55; cursor: default; }
        .dhh-mode-name { font-size: 12px; font-weight: 600; line-height: 1.4; }
        .dhh-mode-desc {
          font-size: 11px; line-height: 1.45;
          color: var(--dsw-alias-label-secondary, #9a9ca6);
        }
        .dhh-mode-badge {
          font-size: 11px; line-height: 1.4;
          color: var(--dsw-alias-label-tertiary, #777a86);
        }
        .dhh-cancel {
          align-self: flex-end; border: none; background: transparent;
          color: var(--dsw-alias-label-tertiary, #777a86);
          font-family: inherit; font-size: 11px; line-height: 1.4;
          padding: 2px 4px; border-radius: var(--dsw-radius-xs, 4px); cursor: pointer;
        }
        .dhh-cancel:hover { color: var(--dsw-alias-label-primary, #ededed); }
        .dhh-status {
          min-height: 19px; font-size: 12px; line-height: 1.6;
          color: var(--dsw-alias-label-tertiary, #777a86);
          overflow-wrap: anywhere;
        }
        .dhh-status.is-error { color: var(--dsw-alias-state-error-primary, #f0524f); }
        .dhh-nav-row { -webkit-app-region: no-drag; }
        .dhh-nav-glyph {
          font-size: 16px; font-weight: 400; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center;
          color: inherit;
        }
        .dhh-nav-label {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .dhh-nav-row.dhh-nav-row-rail .dhh-nav-label { display: none; }
        .dhh-nav-row.dhh-nav-row-rail {
          box-sizing: border-box; width: 36px; height: 36px;
          flex: none; align-self: center; margin: 0 auto 4px; padding: 0; gap: 0;
          justify-content: center; align-items: center;
          display: flex; border-radius: var(--dsw-radius-md, 10px);
        }
        .dhh-nav-row-fallback {
          box-sizing: border-box; width: calc(100% - 4px); min-height: 36px;
          display: flex; align-items: center; gap: 8px;
          margin: 0 2px; padding: 7px 8px; border: none;
          border-radius: var(--dsw-radius-md, 10px);
          background: transparent; color: var(--dsw-alias-label-primary, #ededed);
          font-family: inherit; font-size: 14px; line-height: 22px;
          text-align: left; cursor: pointer;
        }
        .dhh-nav-row-fallback:hover {
          background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
        }
        .dhh-dialog button:focus-visible, .dhh-nav-row:focus-visible {
          outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary, #4c8dff);
          outline-offset: 1px;
        }
      `
      const parent = document.head || document.documentElement
      if (parent) parent.appendChild(style)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Small DOM / formatting helpers
    // ═══════════════════════════════════════════════════════════════════════

    function createElement(tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    }

    function setAttribute(node, name, value) {
      try {
        node.setAttribute(name, String(value))
      } catch {
        /* attribute failures are cosmetic */
      }
    }

    /** Add/remove ONE class token without disturbing the native class list. */
    function setClassToken(element, token, enabled) {
      if (!element) return
      try {
        const current = String(element.className || '')
        const tokens = current.split(/\s+/).filter(Boolean).filter((value) => value !== token)
        if (enabled) tokens.push(token)
        const next = tokens.join(' ')
        // Only touch the attribute when it actually changes: the entry probe
        // observes class mutations, so a no-op rewrite would re-schedule itself.
        if (current !== next) element.className = next
      } catch {
        /* class juggling is cosmetic */
      }
    }

    function addClassToken(element, token) {
      if (!element) return
      try {
        const tokens = String(element.className || '').split(/\s+/).filter(Boolean)
        if (!tokens.includes(token)) tokens.push(token)
        element.className = tokens.join(' ')
      } catch {
        /* ignore */
      }
    }

    function removeNode(node) {
      if (!node) return
      try {
        node.remove()
      } catch {
        try {
          if (node.parentElement && typeof node.parentElement.removeChild === 'function') {
            node.parentElement.removeChild(node)
          }
        } catch {
          /* ignore */
        }
      }
    }

    function isVisible(element) {
      if (!element || !element.isConnected) return false
      try {
        const rect = element.getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0)) return false
        if (element.offsetParent === null) return false
        const style =
          typeof window !== 'undefined' && window && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(element)
            : null
        if (!style) return false
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      } catch {
        return false
      }
    }

    function isSeatVisible(seat) {
      if (!seat || !seat.isConnected) return false
      try {
        const rect = seat.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      } catch {
        return false
      }
    }

    /** HH:MM (24h) from an epoch-ms timestamp; '' when unknown. */
    function formatClock(value) {
      const time = Number(value)
      if (!Number.isFinite(time) || time <= 0) return ''
      try {
        const date = new Date(time)
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        return `${hh}:${mm}`
      } catch {
        return ''
      }
    }

    function normalizeText(value, max) {
      if (value === undefined || value === null) return ''
      const text = String(value).replace(/\r\n/g, '\n').trim()
      if (!max || text.length <= max) return text
      return `${text.slice(0, max - 1)}…`
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Portal host
    // ═══════════════════════════════════════════════════════════════════════

    function ensurePortalHost() {
      if (typeof document === 'undefined') return null
      let host = document.getElementById(PORTAL_HOST_ID)
      if (!host) {
        const parent = document.body || document.documentElement
        if (!parent) return null
        host = document.createElement('div')
        host.id = PORTAL_HOST_ID
        parent.appendChild(host)
      }
      return host
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Sidebar nav-row entry
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The native panel `<nav>` (`nav [class*="_panelList"]`) is NOT a declared
    // injection slot, so the row is DOM-mounted and re-validated on shell
    // mutations. Structural probes only (no compiled class hash): the shell may
    // rename its CSS-module classes between releases.

    /** Locate the sidebar's global-panel `<nav>` list. */
    function findNavList(root) {
      if (!root) return null
      const lists = []
      try {
        for (const node of root.querySelectorAll('[class*="_panelList"]')) {
          if (node && node.isConnected) lists.push(node)
        }
      } catch {
        /* selector unsupported */
      }
      if (lists.length > 0) {
        for (const node of lists) {
          try {
            if (String(node.tagName || '').toLowerCase() === 'nav') return node
          } catch {
            /* keep looking */
          }
        }
        return lists[0]
      }
      // Fallback: any <nav> whose children look like panel rows.
      try {
        for (const node of root.querySelectorAll('nav')) {
          if (!node || !node.isConnected) continue
          let looksLikePanels = false
          try {
            looksLikePanels = node.querySelectorAll('[class*="_panelRow"]').length > 0
          } catch {
            looksLikePanels = false
          }
          if (looksLikePanels) return node
        }
      } catch {
        /* ignore */
      }
      return null
    }

    /** The native row to clone — 「更多」 when present, else the last panel row. */
    function findNativePanelRow(navList) {
      let rows = []
      try {
        rows = Array.from(navList.querySelectorAll('[class*="_panelRow"]'))
      } catch {
        rows = []
      }
      if (rows.length === 0) {
        try {
          rows = Array.from(navList.children || []).filter(
            (child) => child && String(child.tagName || '').toLowerCase() === 'button',
          )
        } catch {
          rows = []
        }
      }
      for (const row of rows) {
        try {
          // `includes`, not `===`: the shipped row may render an icon node with
          // a text glyph next to the label (a strict equality would silently
          // fall back to "last panel row" and clone the wrong row).
          if (String(row.textContent || '').trim().includes(MORE_LABEL)) return row
        } catch {
          /* keep looking */
        }
      }
      return rows.length > 0 ? rows[rows.length - 1] : null
    }

    /** True while the sidebar is in the 56px rail (collapsed) state. */
    function isRailSidebar(root) {
      try {
        const rect = root && typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null
        if (rect && rect.width > 0 && rect.width < 120) return true
        let node = root
        while (node && node !== document.documentElement) {
          if (String(node.className || '').includes('_collapsed')) return true
          node = node.parentElement
        }
      } catch {
        /* fall through */
      }
      return false
    }

    /**
     * Locate the sidebar shell root by STRUCTURE, not by one fragile class.
     * `_sidebarCol` is ui-layout's grid column; the sidebar package renders a
     * `_root` shell inside it that owns `_newSession`/`_logoRow`/`_footArea`.
     */
    function findSidebarRoot() {
      if (typeof document === 'undefined') return null
      const candidates = []
      try {
        for (const column of document.querySelectorAll('[class*="_sidebarCol"]')) {
          if (!column || !column.isConnected) continue
          const shell = column.querySelector('[class*="_root"]')
          if (shell) candidates.push(shell)
          else if (column.firstElementChild) candidates.push(column.firstElementChild)
        }
        for (const shell of document.querySelectorAll('[class*="_root"]')) {
          if (!shell || !shell.isConnected) continue
          if (!shell.querySelector('[class*="_footArea"]') && !shell.querySelector('[class*="_footerActions"]')) {
            try {
              if (!shell.querySelector('[class*="_newSession"]') && !shell.querySelector('[class*="_logoRow"]')) continue
            } catch {
              continue
            }
          }
          candidates.push(shell)
        }
      } catch {
        return null
      }
      for (const shell of candidates) {
        try {
          if (!shell.isConnected) continue
          if (!shell.querySelector('[class*="_newSession"],[class*="_logoRow"],[class*="_footArea"]')) continue
          return shell
        } catch {
          /* keep looking */
        }
      }
      return null
    }

    /**
     * dsh-project-hub's own row (the seat we want to follow), when present.
     * Detected by its VISIBLE label, never by its id/class — this plugin must
     * not depend on (or reuse) another plugin's DOM identifiers.
     */
    function findProjectHubRow(rows) {
      for (const row of rows) {
        if (!row) continue
        try {
          if (String(row.tagName || '').toLowerCase() !== 'button') continue
          if (String(row.textContent || '').includes(PROJECT_HUB_LABEL)) return row
        } catch {
          /* keep looking */
        }
      }
      return null
    }

    /**
     * True when `row` belongs to ANOTHER plugin's entry (it carries a
     * `data-<something>-entry` marker or a conventional plugin entry id).
     * Our rule: never move/overwrite such a row — walk past it instead.
     */
    function isForeignEntryRow(row) {
      if (!row || row === (navRow && navRow.row)) return false
      let foreign = false
      try {
        const attrs = row.attributes
        if (attrs && typeof attrs.length === 'number') {
          for (let index = 0; index < attrs.length; index += 1) {
            const name = String((attrs[index] && attrs[index].name) || '')
            if (/^data-.*-entry$/i.test(name)) {
              foreign = true
              break
            }
          }
        }
      } catch {
        foreign = false
      }
      if (!foreign) {
        const id = String((row && row.id) || '')
        // Our own attr check first; any other plugin's `-entry`/`-nav-row` id
        // also means "occupied seat".
        foreign = /-entry(-row)?$/.test(id) || /-nav-row$/.test(id)
      }
      return foreign
    }

    /** Index in `others` where our row should sit (0 = before first child). */
    function computeInsertIndex(others) {
      const list = Array.isArray(others) ? others : []
      if (list.length === 0) return 0
      let anchor = findProjectHubRow(list)
      if (!anchor) {
        // No 项目工坊 row: fall back to 「更多」, then to the last native row.
        let native = list.find((row) => {
          try {
            return String(row.textContent || '').trim().includes(MORE_LABEL)
          } catch {
            return false
          }
        })
        if (!native) {
          native = list.find((row) => /_panelRow/.test(String(row.className || '')))
        }
        anchor = native || list[list.length - 1]
      }
      let index = list.indexOf(anchor) + 1
      // Conflict handling: another plugin's entry occupies the next slot(s).
      // Walk DOWN to the first free seat, never move or overwrite those rows.
      while (index < list.length && isForeignEntryRow(list[index])) index += 1
      return index
    }

    /**
     * Insert/move the row into the nav list at the first free seat.
     *
     * ZERO DOM writes when the row already sits in that seat. This is the
     * anti-flicker guard: a plain `appendChild()` of an already-last child, or
     * `insertBefore(row, row.nextSibling)`, still removes + re-inserts the node
     * in Chromium and fires childList mutations — which the entry probe would
     * observe and re-trigger (the historical 60 ms self-loop that made the
     * sidebar entry blink).
     */
    function insertNavRow(navList, row) {
      const children = Array.from(navList.children || [])
      const others = children.filter((child) => child !== row)
      const index = computeInsertIndex(others)
      const reference = index < others.length ? others[index] : null
      const current = Array.from(navList.children || [])
      if (!reference) {
        if (current.length > 0 && current[current.length - 1] === row) return
        navList.appendChild(row)
        return
      }
      const targetIndex = current.indexOf(reference)
      if (targetIndex > 0 && current[targetIndex - 1] === row) return
      navList.insertBefore(row, reference)
    }

    /** Insert the row in the sidebar's own column (collapsed rail fallback). */
    function insertNavRowInRail(root, row) {
      if (!root || row.parentElement === root) return
      let anchor = null
      try {
        const siblings = Array.from(root.children || [])
        anchor = findProjectHubRow(siblings)
      } catch {
        anchor = null
      }
      if (!anchor) {
        try {
          anchor = root.querySelector('[class*="_newSession"]')
        } catch {
          anchor = null
        }
      }
      if (anchor && anchor.parentElement === root) {
        const siblings = Array.from(root.children || [])
        const index = siblings.indexOf(anchor)
        if (index >= 0) {
          root.insertBefore(row, siblings[index + 1] || null)
          return
        }
      }
      root.appendChild(row)
    }

    /**
     * Drop ANIMATION-ONLY native classes from a clone while keeping the layout
     * classes. The shell's panel titles carry `_wide` (`animation: …-in .2s`,
     * 0% { opacity: 0 }); cloning it means every (re)insertion replays a 0.2 s
     * fade — one of the sources of the "UI 在闪" report. Never throws.
     */
    function stripAnimationClasses(root) {
      if (!root) return
      const nodes = [root]
      try {
        for (const node of root.querySelectorAll('[class]')) nodes.push(node)
      } catch {
        /* selector unsupported: only the root is processed */
      }
      for (const node of nodes) {
        try {
          const classes = String(node.className || '').split(/\s+/).filter(Boolean)
          const kept = classes.filter((token) => !/(?:^|_)(?:wide|fading|railIn|appear)$/.test(token))
          if (kept.length !== classes.length) node.className = kept.join(' ')
        } catch {
          /* class juggling is cosmetic */
        }
      }
    }

    /**
     * Build the entry row: clone the native panel row (native structure +
     * classes → native spacing, hover, focus ring) and swap in our glyph/label.
     */
    function createNavRow(refRow) {
      let row = null
      let cloned = false
      if (refRow && typeof refRow.cloneNode === 'function') {
        try {
          row = refRow.cloneNode(true)
          cloned = Boolean(row)
        } catch {
          row = null
          cloned = false
        }
      }
      if (!row) row = document.createElement('button')

      // Never inherit the native row's transient state (e.g. the 「更多」 popup
      // being open marks it `_panelActive`); only the layout classes are reused.
      const baseClasses = String(row.className || '')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !/_panelActive$/.test(token))
      row.className = baseClasses.concat(NAV_ROW_CLASS).concat(cloned ? [] : [NAV_ROW_FALLBACK_CLASS]).join(' ')
      row.id = NAV_ROW_ID
      setAttribute(row, 'type', 'button')
      setAttribute(row, 'title', ENTRY_LABEL)
      setAttribute(row, 'aria-label', ENTRY_LABEL)
      setAttribute(row, ENTRY_ATTR, '1')
      for (const name of ['aria-haspopup', 'aria-expanded', 'aria-current', 'aria-pressed', 'disabled']) {
        if (typeof row.removeAttribute === 'function') {
          try {
            row.removeAttribute(name)
          } catch {
            /* ignore */
          }
        }
      }

      let glyph = null
      let label = null
      try {
        glyph = row.querySelector('[class*="_panelGlyph"]')
      } catch {
        glyph = null
      }
      try {
        label = row.querySelector('[class*="_panelTitle"]')
      } catch {
        label = null
      }
      if (!glyph) {
        glyph = document.createElement('span')
        if (label && label.parentElement === row && typeof row.insertBefore === 'function') {
          try {
            row.insertBefore(glyph, label)
          } catch {
            row.appendChild(glyph)
          }
        } else {
          row.appendChild(glyph)
        }
      }
      if (!label) {
        label = document.createElement('span')
        row.appendChild(label)
      }
      addClassToken(glyph, NAV_GLYPH_CLASS)
      addClassToken(label, NAV_LABEL_CLASS)
      glyph.textContent = ENTRY_GLYPH
      label.textContent = ENTRY_LABEL

      row.addEventListener('click', (event) => {
        try {
          event.preventDefault()
          event.stopPropagation()
        } catch {
          /* ignore */
        }
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(TOGGLE_EVENT))
          }
        } catch {
          /* observability only */
        }
        toggleDialog()
      })
      row.addEventListener('mousedown', (event) => {
        try {
          event.stopPropagation()
        } catch {
          /* ignore */
        }
      })
      stripAnimationClasses(row)
      return row
    }

    /** Detach the nav row (teardown only — never someone else's node). */
    function removeNavRow() {
      try {
        if (navRow && navRow.row) removeNode(navRow.row)
      } catch {
        /* ignore */
      }
      try {
        const stale = document.getElementById(NAV_ROW_ID)
        if (stale) removeNode(stale)
      } catch {
        /* ignore */
      }
      navRow = null
    }

    /**
     * Find the row's seat: the native panel list (wide sidebar) or the sidebar
     * root column (collapsed rail / a shell that does not render a panel list).
     * @returns {{seat: *, kind: 'nav'|'rail', navList: *}|null}
     */
    function findNavSeat(root) {
      const navList = findNavList(root)
      const seatInNav = Boolean(navList) && isSeatVisible(navList) && !isRailSidebar(root)
      if (seatInNav) return { seat: navList, kind: 'nav', navList }
      if (root && root.isConnected) return { seat: root, kind: 'rail', navList }
      return null
    }

    /**
     * Keep the row painted in the sidebar: below 项目工坊 (the first free seat
     * after it), or — while the native nav list is hidden — relocated into the
     * sidebar column as a glyph-only rail row.
     *
     * STABILITY CONTRACT (this is the anti-flicker fix):
     *   - exactly ONE node, ever (`#dhh-nav-row`);
     *   - a sync that finds the row already in the right seat performs ZERO DOM
     *     writes, so it can never re-trigger the MutationObserver that scheduled
     *     it (the old code re-`appendChild`-ed the row every 60 ms: remove +
     *     insert at ~16 Hz replayed the native title animation and made the
     *     whole sidebar entry blink);
     *   - the seat is tracked (`navRow.seat` / `navRow.kind`), so React wiping
     *     the row is repaired by an idempotent re-mount instead of churn.
     */
    function syncNavEntry() {
      try {
        if (typeof document === 'undefined' || disposed) return

        const root = findSidebarRoot()
        if (!root) {
          // The sidebar is not mounted (yet); a detached row is dropped so the
          // next probe pass re-creates it in whatever shell is there by then.
          if (navRow && navRow.row && !navRow.row.isConnected) navRow = null
          return
        }

        // Fold a stale copy left by a React re-render / a previous seat into
        // `navRow` — never leave two `data-dhh-entry` nodes behind.
        let existing = null
        try {
          existing = document.getElementById(NAV_ROW_ID)
        } catch {
          existing = null
        }
        if (
          existing &&
          navRow &&
          navRow.row !== existing &&
          existing.getAttribute &&
          existing.getAttribute(ENTRY_ATTR) === '1'
        ) {
          removeNode(navRow.row && navRow.row !== existing ? navRow.row : existing)
        }
        if (existing && (!navRow || navRow.row !== existing)) {
          if (existing.getAttribute && existing.getAttribute(ENTRY_ATTR) === '1') {
            navRow = { row: existing, cloned: Boolean(existing.className), seat: null, kind: null }
          }
        }
        if (navRow && navRow.row && !navRow.row.isConnected) navRow = null
        if (navRow && navRow.seat && !navRow.seat.isConnected) navRow = null

        const seat = findNavSeat(root)
        if (!seat) return

        if (!navRow) {
          navRow = {
            row: createNavRow(seat.navList ? findNativePanelRow(seat.navList) : null),
            cloned: Boolean(seat.navList),
            seat: null,
            kind: null,
          }
        }

        if (navRow.seat !== seat.seat || navRow.kind !== seat.kind) {
          // Seat changed (expand/collapse/shell re-render): move the SAME node.
          if (seat.kind === 'nav') insertNavRow(seat.seat, navRow.row)
          else insertNavRowInRail(seat.seat, navRow.row)
          navRow.seat = seat.seat
          navRow.kind = seat.kind
        } else if (seat.kind === 'nav') {
          // Same seat: insertNavRow() is idempotent and writes NOTHING when the
          // node is already on its seat, so this self-heals ordering without
          // ever producing a mutation of its own.
          insertNavRow(seat.seat, navRow.row)
        }
        setClassToken(navRow.row, NAV_ROW_RAIL_CLASS, seat.kind === 'rail' || isRailSidebar(root))
      } catch {
        /* the probe must never break the client module */
      }
    }

    /** Coalesced, self-terminating remount timer (never bumped by its own work). */
    function scheduleMount(delay) {
      if (disposed || mountTimer) return
      mountTimer = setTimeout(() => {
        mountTimer = null
        syncNavEntry()
      }, typeof delay === 'number' ? delay : 120)
      try {
        if (mountTimer && typeof mountTimer.unref === 'function') mountTimer.unref()
      } catch {
        /* browsers return a number */
      }
    }

    /** Collapse/expand/titlebar changes only: cheap and rare. */
    function scheduleSeatSync() {
      if (disposed || seatTimer) return
      seatTimer = setTimeout(() => {
        seatTimer = null
        syncNavEntry()
      }, 100)
      try {
        if (seatTimer && typeof seatTimer.unref === 'function') seatTimer.unref()
      } catch {
        /* browsers return a number */
      }
    }

    /** True only while our single entry node is connected to the document. */
    function entryMounted() {
      return Boolean(navRow && navRow.row && navRow.row.isConnected)
    }

    /**
     * Event-driven entry probe — NO setInterval, NO requestAnimationFrame, and
     * no observer that reacts to its own writes:
     *
     *   1. one immediate mount;
     *   2. `bodyObserver` is a pure O(1) liveness check: while our node is
     *      connected it does nothing, so inserting the row can never re-arm it
     *      (this is what killed the old 60 ms self-sustaining loop);
     *   3. `chromeObserver` listens only to the shell's sidebar/titlebar
     *      attributes (collapse/expand), never to class churn;
     *   4. a handful of bounded retries covers the boot race (the sidebar may
     *      mount after this plugin) and dies once the row is mounted.
     */
    function installEntryProbe() {
      syncNavEntry()

      const retryTimers = []
      const registerRetry = (delay) => {
        const timer = setTimeout(() => {
          // Bounded boot verification only: a correct seat means zero writes.
          if (!disposed) syncNavEntry()
        }, delay)
        try {
          if (timer && typeof timer.unref === 'function') timer.unref()
        } catch {
          /* browsers return a number */
        }
        retryTimers.push(timer)
      }

      if (
        typeof MutationObserver === 'function' &&
        typeof document !== 'undefined' &&
        document.body
      ) {
        try {
          bodyObserver = new MutationObserver(() => {
            if (disposed) return
            // O(1) early exit: our node is alive -> nothing to do. This is the
            // entire anti-self-trigger guarantee.
            if (entryMounted()) return
            scheduleMount(120)
          })
          bodyObserver.observe(document.body, { childList: true, subtree: true })
        } catch {
          bodyObserver = null
        }
      }

      const chromeRoot =
        typeof document !== 'undefined' ? document.documentElement || document.body : null
      if (chromeRoot && typeof MutationObserver === 'function') {
        try {
          chromeObserver = new MutationObserver(() => {
            if (!disposed) scheduleSeatSync()
          })
          chromeObserver.observe(chromeRoot, {
            attributes: true,
            subtree: true,
            attributeFilter: ['data-sidebar-collapsed', 'data-windows-titlebar', 'data-platform'],
          })
        } catch {
          chromeObserver = null
        }
      }

      for (const delay of [120, 400, 900, 1600, 2800, 4500]) registerRetry(delay)

      return () => {
        try {
          if (bodyObserver) bodyObserver.disconnect()
        } catch {
          /* ignore */
        }
        bodyObserver = null
        try {
          if (chromeObserver) chromeObserver.disconnect()
        } catch {
          /* ignore */
        }
        chromeObserver = null
        for (const timer of retryTimers) {
          try {
            clearTimeout(timer)
          } catch {
            /* ignore */
          }
        }
        retryTimers.length = 0
        if (mountTimer) {
          try {
            clearTimeout(mountTimer)
          } catch {
            /* ignore */
          }
          mountTimer = null
        }
        if (seatTimer) {
          try {
            clearTimeout(seatTimer)
          } catch {
            /* ignore */
          }
          seatTimer = null
        }
        removeNavRow()
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Dialog — exactly two blocks: messages + handoff button; the mode picker
    // and the one-line status live under the button.
    // ═══════════════════════════════════════════════════════════════════════

    function buildDialog() {
      if (typeof document === 'undefined') return null
      if (dialogEl && dialogEl.isConnected) return els
      const host = ensurePortalHost()
      if (!host) return null

      const existing = document.getElementById(DIALOG_ID)
      if (existing) removeNode(existing)

      const overlay = document.createElement('div')
      overlay.id = OVERLAY_ID
      overlay.className = 'dhh-overlay'
      overlay.style.display = 'none'
      setAttribute(overlay, OVERLAY_ATTR, '1')

      const dialog = document.createElement('div')
      dialog.id = DIALOG_ID
      dialog.className = 'dhh-dialog'
      setAttribute(dialog, DIALOG_ATTR, '1')
      setAttribute(dialog, 'role', 'dialog')
      setAttribute(dialog, 'aria-modal', 'true')
      setAttribute(dialog, 'aria-label', ENTRY_LABEL)

      // ── chrome: title + quiet close button
      const head = createElement('div', 'dhh-head')
      head.appendChild(createElement('span', 'dhh-title', ENTRY_LABEL))
      const closeBtn = createElement('button', 'dhh-close', '×')
      closeBtn.id = CLOSE_ID
      setAttribute(closeBtn, 'type', 'button')
      setAttribute(closeBtn, 'aria-label', '关闭')
      closeBtn.addEventListener('click', closeDialog)
      head.appendChild(closeBtn)

      // ── block 1: scrollable hint list
      const messages = document.createElement('div')
      messages.id = MESSAGE_LIST_ID
      messages.className = 'dhh-messages'
      setAttribute(messages, MESSAGES_ATTR, '1')
      setAttribute(messages, 'role', 'list')

      // ── block 2: handoff button (+ mode picker + status line below it)
      const actions = createElement('div', 'dhh-actions')

      const handoffBtn = createElement('button', 'dhh-primary', '交接会话')
      handoffBtn.id = HANDOFF_BTN_ID
      setAttribute(handoffBtn, 'type', 'button')
      handoffBtn.addEventListener('click', () => {
        if (busy) return
        if (modePickerOpen) {
          hideModePicker()
          return
        }
        showModePicker()
      })

      const picker = document.createElement('div')
      picker.id = MODE_PICKER_ID
      picker.className = 'dhh-mode-picker'
      picker.style.display = 'none'

      const cancel = createElement('button', 'dhh-cancel', '取消')
      cancel.id = CANCEL_ID
      setAttribute(cancel, 'type', 'button')
      cancel.addEventListener('click', hideModePicker)

      const status = document.createElement('div')
      status.id = STATUS_ID
      status.className = 'dhh-status'
      setAttribute(status, STATUS_ATTR, '1')
      setAttribute(status, 'aria-live', 'polite')
      status.textContent = '正在读取状态…'

      actions.appendChild(handoffBtn)
      actions.appendChild(picker)
      actions.appendChild(status)
      dialog.appendChild(head)
      dialog.appendChild(messages)
      dialog.appendChild(actions)
      overlay.appendChild(dialog)
      host.appendChild(overlay)

      overlay.addEventListener('click', (event) => {
        try {
          if (event.target === overlay) closeDialog()
        } catch {
          /* ignore */
        }
      })

      overlayEl = overlay
      dialogEl = dialog
      messageListEl = messages
      handoffBtnEl = handoffBtn
      modePickerEl = picker
      cancelBtnEl = cancel
      statusEl = status
      els = {
        overlay,
        dialog,
        head,
        closeBtn,
        messages,
        actions,
        handoffBtn,
        picker,
        cancel,
        status,
      }
      // A rebuilt dialog owns brand-new nodes: force the list/status to render
      // into them even if the cached data is unchanged.
      messagesKey = ''
      renderMessages(hintsCache)
      renderStatus(stateCache)
      return els
    }

    /** Render the real mode catalog (host `modes` wins; fallback has both modes). */
    function renderModes(modes) {
      if (!modePickerEl) return
      const list = Array.isArray(modes) && modes.length > 0 ? modes : FALLBACK_MODES
      const key = JSON.stringify(
        list.map((mode) => [String(mode && mode.id), Boolean(mode && mode.description)]),
      )
      if (key === modesKey && modePickerEl.children.length > 0) return
      modesKey = key
      modesCache = list
      while (modePickerEl.firstElementChild) removeNode(modePickerEl.firstElementChild)

      for (const mode of list) {
        if (!mode || typeof mode.id !== 'string' || !mode.id) continue
        const name = normalizeText(mode.name, 60) || mode.id
        const description = normalizeText(mode.description, 90)
        const option = document.createElement('button')
        option.className = 'dhh-mode'
        option.id = `dhh-mode-${String(mode.id).replace(/[^a-z0-9-]/gi, '-')}`
        setAttribute(option, 'type', 'button')
        setAttribute(option, MODE_ATTR, mode.id)
        option.appendChild(createElement('span', 'dhh-mode-name', name))
        if (description) option.appendChild(createElement('span', 'dhh-mode-desc', description))
        // The small print the user asked for: BOTH modes are full access.
        option.appendChild(createElement('span', 'dhh-mode-badge', '完全权限'))
        option.addEventListener('click', () => {
          triggerHandoff(mode.id)
        })
        modePickerEl.appendChild(option)
      }
      if (cancelBtnEl) modePickerEl.appendChild(cancelBtnEl)
    }

    function showModePicker() {
      if (!modePickerEl) return
      modePickerOpen = true
      renderModes(modesCache.length > 0 ? modesCache : stateCache && stateCache.modes)
      modePickerEl.style.display = 'flex'
      if (handoffBtnEl) handoffBtnEl.style.display = 'none'
      if (statusEl) statusEl.classList && statusEl.classList.remove('is-error')
      setStatusText(statusOverride ? statusOverride.text : computeStatusText(stateCache))
    }

    function hideModePicker() {
      modePickerOpen = false
      if (modePickerEl) modePickerEl.style.display = 'none'
      if (handoffBtnEl) handoffBtnEl.style.display = ''
      if (statusEl) renderStatus(stateCache)
    }

    function computeStatusText(state) {
      if (!state || state.ok === false) {
        // Keep the format stable: x/y unknown is shown as an em dash, never as
        // a made-up 0, and the off/triggered wording stays truthful.
        const reason = state && state.error ? String(state.error) : '状态不可用'
        return `压缩轮数 — · 自动交接 未触发（${reason}）`
      }
      const compactions = state.compactions || {}
      const autoRounds = Math.max(0, Math.floor(Number(compactions.auto) || 0))
      const rawThreshold = Number(compactions.threshold)
      const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? Math.floor(rawThreshold) : 1
      const configEnabled =
        !(state.config && state.config.enabled === false) &&
        !(state.autoHandoff && state.autoHandoff.enabled === false)
      let autoText
      if (!configEnabled) {
        autoText = '自动交接 已关闭'
      } else {
        const lastAt = Number(state.autoHandoff && state.autoHandoff.lastAt)
        if (Number.isFinite(lastAt) && lastAt > 0) {
          autoText = `自动交接 已触发（${formatClock(lastAt)}）`
        } else {
          autoText = '自动交接 未触发'
        }
      }
      return `压缩轮数 ${autoRounds}/${threshold} · ${autoText}`
    }

    function setStatusText(text, isError) {
      if (!statusEl) return
      const next = text === undefined || text === null ? '' : String(text)
      // Only touch the DOM when the text really changed: a 2 s poll that
      // re-writes identical text would still replace the text node (mutation,
      // layout) and can visibly flicker.
      if (statusEl.textContent !== next) statusEl.textContent = next
      if (statusEl.classList) {
        if (isError) statusEl.classList.add('is-error')
        else statusEl.classList.remove('is-error')
      }
    }

    function renderStatus(state) {
      if (!statusEl) return
      const override = statusOverride
      if (override && Date.now() < override.until) {
        setStatusText(override.text, override.isError === true)
        return
      }
      statusOverride = null
      setStatusText(computeStatusText(state), false)
    }

    function renderMessages(hints) {
      if (!messageListEl) return
      const list = Array.isArray(hints) ? hints : []
      hintsCache = list
      // Signature guard: the dialog polls at a low frequency, but an unchanged
      // hint list must not rebuild its nodes (that would reset the user's
      // scroll position and churn the DOM for nothing).
      let key = ''
      try {
        key = JSON.stringify(
          list.map((hint) => {
            const row = hint && typeof hint === 'object' ? hint : {}
            return [row.id, row.ts, row.level, row.read, row.title, row.body]
          }),
        )
      } catch {
        key = ''
      }
      if (key === messagesKey && messageListEl.children.length > 0) return
      messagesKey = key
      while (messageListEl.firstElementChild) removeNode(messageListEl.firstElementChild)
      if (list.length === 0) {
        messageListEl.appendChild(createElement('div', 'dhh-empty', '暂无提示，安静一下。'))
        return
      }
      for (const hint of list) {
        if (!hint || typeof hint !== 'object') continue
        const level = hint.level === 'error' || hint.level === 'warn' ? hint.level : 'info'
        const row = document.createElement('div')
        row.className = `dhh-message is-${level}` + (hint.read === true ? ' is-read' : '')
        setAttribute(row, 'role', 'listitem')
        row.appendChild(createElement('span', 'dhh-message-dot'))
        const main = createElement('div', 'dhh-message-main')
        const line = createElement('div', 'dhh-message-line')
        line.appendChild(createElement('span', 'dhh-message-title', normalizeText(hint.title, 200) || '（无标题）'))
        const clock = formatClock(hint.ts)
        if (clock) line.appendChild(createElement('span', 'dhh-message-time', clock))
        main.appendChild(line)
        if (hint.body) main.appendChild(createElement('div', 'dhh-message-body', normalizeText(hint.body, 1200)))
        row.appendChild(main)
        messageListEl.appendChild(row)
      }
    }

    // ── Data refresh ───────────────────────────────────────────────────────

    function pollInterval() {
      const configured = Number(pollMs)
      if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_POLL_MS
      return Math.min(MAX_DIALOG_POLL_MS, Math.max(MIN_POLL_MS, Math.round(configured)))
    }

    function startPolling() {
      stopPolling()
      if (disposed) return
      pollTimer = setInterval(() => {
        refresh().catch(() => {})
      }, pollInterval())
      try {
        if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref()
      } catch {
        /* browsers return a number */
      }
    }

    function stopPolling() {
      if (!pollTimer) return
      try {
        clearInterval(pollTimer)
      } catch {
        /* ignore */
      }
      pollTimer = null
    }

    /** One full refresh: hint list + handoff state, both rendered defensively. */
    async function refresh() {
      if (disposed || typeof document === 'undefined') return
      let hintPayload = null
      let statePayload = null
      try {
        const [hintRes, stateRes] = await Promise.all([
          requestApi('/hint/list', { method: 'GET' }),
          requestApi('/handoff/state', { method: 'GET' }),
        ])
        if (disposed) return
        hintPayload = hintRes && hintRes.ok ? hintRes.data : null
        statePayload = stateRes && stateRes.ok ? stateRes.data : null
      } catch {
        if (disposed) return
      }
      if (disposed) return
      if (hintPayload && hintPayload.ok !== false) {
        renderMessages(Array.isArray(hintPayload.hints) ? hintPayload.hints : [])
        const configuredPoll = Number(hintPayload.config && hintPayload.config.pollMs)
        if (Number.isFinite(configuredPoll) && configuredPoll > 0) pollMs = configuredPoll
      }
      if (statePayload && statePayload.ok !== false) {
        stateCache = statePayload
        renderModes(statePayload.modes)
        renderStatus(stateCache)
      } else {
        stateCache = statePayload && statePayload.error ? statePayload : null
        renderStatus(stateCache)
      }
      return { hints: hintsCache, state: stateCache }
    }

    // ── Handoff action ─────────────────────────────────────────────────────

    function setBusy(next) {
      busy = Boolean(next)
      if (handoffBtnEl) handoffBtnEl.disabled = busy
      if (modePickerEl) {
        for (const child of Array.from(modePickerEl.children || [])) {
          if (child && child.id && child.id.indexOf('dhh-mode-') === 0) child.disabled = busy
        }
      }
    }

    /** Human text for a /handoff/prepare failure (never a raw stack). */
    function handoffErrorText(data, status) {
      const payload = data && typeof data === 'object' ? data : {}
      if (payload.error === 'session-not-found') return '未找到可交接的会话'
      if (Array.isArray(payload.reasons) && payload.reasons.length > 0) {
        const reasons = payload.reasons.map((reason) => {
          const text = String(reason)
          if (text.startsWith('agent-')) return '代理仍在忙'
          if (text === 'open-turn') return '当前回合未结束'
          if (text === 'compaction-in-flight') return '压缩进行中'
          if (text.startsWith('unanswered-tool-calls')) return '仍有未返回的工具调用'
          if (text === 'disabled') return '插件已停用'
          return text
        })
        return Array.from(new Set(reasons)).join('、')
      }
      if (payload.error) return String(payload.error)
      return `宿主返回 HTTP ${status}`
    }

    /**
     * The only write action of the dialog: POST /handoff/prepare with
     * `{ force: true, mode }` — the mode is the option the user just picked.
     */
    async function triggerHandoff(modeId) {
      if (busy || disposed) return
      const mode = String(modeId || '') || 'standard'
      setBusy(true)
      statusOverride = { text: '交接中…', until: Date.now() + 60000 }
      renderStatus(stateCache)
      let ok = false
      try {
        const res = await requestApi('/handoff/prepare', {
          method: 'POST',
          body: { force: true, mode },
        })
        const data = res && res.data && typeof res.data === 'object' ? res.data : {}
        if (res && res.ok && data.ok === true) {
          ok = true
          const clock = formatClock(Date.now())
          const file = data.handoffFile ? String(data.handoffFile).replace(/^.*[\\/]/, '') : ''
          const bits = ['交接完成']
          if (clock) bits.push(clock)
          if (file) bits.push(file)
          statusOverride = { text: bits.join(' · '), until: Date.now() + STATUS_OVERRIDE_MS }
          hideModePicker()
        } else {
          statusOverride = {
            text: `交接未完成：${handoffErrorText(data, res ? res.status : 0)}`,
            until: Date.now() + STATUS_OVERRIDE_MS,
            isError: true,
          }
        }
      } catch {
        statusOverride = {
          text: '交接未完成：无法连接宿主路由',
          until: Date.now() + STATUS_OVERRIDE_MS,
          isError: true,
        }
      } finally {
        setBusy(false)
        if (ok) hideModePicker()
        // Always re-read the host: the status line must show the REAL counts.
        try {
          await refresh()
        } catch {
          /* refresh is best effort */
        }
        if (statusEl) renderStatus(stateCache)
      }
      return ok
    }

    // ── Open / close ───────────────────────────────────────────────────────

    function onDocumentKeydown(event) {
      if (!dialogOpen) return
      try {
        if (event.key !== 'Escape' && event.keyCode !== 27) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (modePickerOpen) hideModePicker()
        else closeDialog()
      } catch {
        /* ignore */
      }
    }

    let keydownBound = false

    function openDialog() {
      if (disposed || typeof document === 'undefined') return false
      try {
        ensureStyles()
        const built = buildDialog()
        if (!built) return false
        lastFocus = document.activeElement || null
        overlayEl.style.display = 'flex'
        dialogOpen = true
        if (!keydownBound) {
          try {
            document.addEventListener('keydown', onDocumentKeydown)
            keydownBound = true
          } catch {
            keydownBound = false
          }
        }
        refresh().catch(() => {})
        startPolling()
        if (handoffBtnEl && typeof handoffBtnEl.focus === 'function') {
          try {
            handoffBtnEl.focus()
          } catch {
            /* focus is cosmetic */
          }
        }
        return true
      } catch {
        return false
      }
    }

    function closeDialog() {
      if (!dialogOpen) return
      dialogOpen = false
      hideModePicker()
      if (overlayEl) overlayEl.style.display = 'none'
      stopPolling()
      if (keydownBound) {
        try {
          document.removeEventListener('keydown', onDocumentKeydown)
        } catch {
          /* ignore */
        }
        keydownBound = false
      }
      try {
        if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus()
      } catch {
        /* ignore */
      }
      lastFocus = null
    }

    function toggleDialog() {
      if (dialogOpen) closeDialog()
      else openDialog()
    }

    function isDialogOpen() {
      return dialogOpen
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Cordis client exports
    // ═══════════════════════════════════════════════════════════════════════

    /** Teardown for the whole client half (ctx.effect / tests). */
    function dispose() {
      if (disposed) return
      disposed = true
      stopPolling()
      try {
        if (bodyObserver) bodyObserver.disconnect()
      } catch {
        /* ignore */
      }
      bodyObserver = null
      try {
        if (chromeObserver) chromeObserver.disconnect()
      } catch {
        /* ignore */
      }
      chromeObserver = null
      for (const timer of [mountTimer, seatTimer]) {
        try {
          if (timer) clearTimeout(timer)
        } catch {
          /* ignore */
        }
      }
      mountTimer = null
      seatTimer = null
      try {
        if (keydownBound) document.removeEventListener('keydown', onDocumentKeydown)
      } catch {
        /* ignore */
      }
      keydownBound = false
      removeNavRow()
      if (overlayEl) removeNode(overlayEl)
      overlayEl = null
      // The portal host is ours too; drop it once it is empty so unmounting the
      // plugin leaves the shell DOM the way we found it.
      try {
        const host = document.getElementById(PORTAL_HOST_ID)
        const childCount = host && host.children ? host.children.length : 0
        if (host && childCount === 0) removeNode(host)
      } catch {
        /* ignore */
      }
      dialogEl = null
      messageListEl = null
      handoffBtnEl = null
      modePickerEl = null
      statusEl = null
      els = null
      dialogOpen = false
      modePickerOpen = false
    }

    exports.apply = function apply(ctx) {
      try {
        ensureStyles()
      } catch {
        /* styles are cosmetic */
      }
      let disposeProbe = () => {}
      try {
        disposeProbe = installEntryProbe()
      } catch {
        disposeProbe = () => {}
      }
      try {
        buildDialog()
      } catch {
        /* the dialog is rebuilt lazily on open */
      }

      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(
            () => () => {
              try {
                disposeProbe()
              } catch {
                /* ignore */
              }
              try {
                dispose()
              } catch {
                /* ignore */
              }
            },
            'dsh-hint-handoff: sidebar entry + dialog',
          )
        } catch {
          /* unload cleanup is best effort */
        }
      }
    }

    // Test seam: pure helpers + the render/action entry points, so a Node stub
    // DOM can drive the entry probe and the dialog without a browser.
    exports.__test__ = {
      MODULE_ID,
      ENTRY_LABEL,
      ENTRY_GLYPH,
      PORTAL_HOST_ID,
      NAV_ROW_ID,
      NAV_ROW_CLASS,
      NAV_ROW_RAIL_CLASS,
      DIALOG_ID,
      OVERLAY_ID,
      MESSAGE_LIST_ID,
      HANDOFF_BTN_ID,
      MODE_PICKER_ID,
      STATUS_ID,
      ENTRY_ATTR,
      DIALOG_ATTR,
      STATUS_ATTR,
      MODE_ATTR,
      TOGGLE_EVENT,
      resolveHostBase,
      buildApiUrl,
      requestApi,
      ensureStyles,
      ensurePortalHost,
      buildDialog,
      openDialog,
      closeDialog,
      toggleDialog,
      isDialogOpen,
      refresh,
      renderMessages,
      renderModes,
      renderStatus,
      computeStatusText,
      showModePicker,
      hideModePicker,
      triggerHandoff,
      findSidebarRoot,
      findNavList,
      findNativePanelRow,
      findProjectHubRow,
      isForeignEntryRow,
      computeInsertIndex,
      syncNavEntry,
      installEntryProbe,
      dispose,
      debug: () => ({
        dialogOpen,
        modePickerOpen,
        busy,
        pollMs,
        hints: hintsCache.slice(),
        state: stateCache,
        modes: modesCache.slice(),
        navRowConnected: Boolean(navRow && navRow.row && navRow.row.isConnected),
        statusOverride,
      }),
    }

    return module.exports
  }

  try {
    bootstrapClientModule(clientFactory)
  } catch {
    /* the client half is optional UI: never break the shell boot */
  }
})()
