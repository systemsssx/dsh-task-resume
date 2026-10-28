/**
 * dsh-hint-handoff — test/smoke.mjs
 *
 * Dependency-free smoke checks for the merged plugin:
 *
 *   HOST
 *     - `lib/index.js` loads (the schemastery guard degrades to Config=undefined
 *       when the package is not resolvable, exactly like both originals);
 *     - `apply(ctx)` mounts BOTH halves without throwing;
 *     - the 5 `/hint/*` routes + 5 `/handoff/*` routes and the two agent tools
 *       (`post_hint`, `handoff_now`) really are registered.
 *
 *   CLIENT (lib/client.js, evaluated in a stub DOM, like the shipped plugins)
 *     - `apply(ctx)` mounts the portal host + dialog + sidebar entry;
 *     - the entry lands AFTER dsh-project-hub's row, and after any other
 *       plugin's `data-*-entry` row that already occupies that seat — walking
 *       down to the first free slot instead of overwriting/moving anything;
 *     - re-syncing is idempotent (exactly one `#dhh-nav-row`);
 *     - the dialog opens, renders the hint list (empty state text included);
 *     - the status line renders the REAL numbers/threshold:
 *       `压缩轮数 3/8 · 自动交接 已触发（12:04）`, `…已关闭`, `…未触发`;
 *     - 「交接会话」 reveals the two-mode picker, both rows carry the small
 *       「完全权限」 note, and picking one POSTs `/handoff/prepare {force,mode}`;
 *     - unmounting removes ONLY our nodes (project-hub's / the foreign row stay).
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

let passed = 0
function ok(name) {
  passed += 1
  console.log(`  PASS  ${name}`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    let value = false
    try {
      value = Boolean(predicate())
    } catch {
      value = false
    }
    if (value) return true
    await wait(15)
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════
// HOST-SIDE SMOKE — merged plugin module + both route/tool registrations
// ═══════════════════════════════════════════════════════════════════════════

async function hostSmoke() {
  console.log('\n[host] merged lib/index.js')
  // Mute the expected schemastery-guard warning (link: install cannot resolve it).
  const originalWarn = console.warn
  console.warn = () => {}
  let hostModule
  try {
    hostModule = await import('../lib/index.js')
  } finally {
    console.warn = originalWarn
  }
  assert.equal(hostModule.name, 'dsh-hint-handoff')
  assert.equal(hostModule.version, '0.1.0')
  assert.equal(typeof hostModule.apply, 'function')
  assert.equal(hostModule.Config, undefined, 'Config must stay undefined when schemastery is not resolvable')
  ok('module exports name/version/apply, Config guard degraded safely')

  const routes = []
  const tools = []
  const disposers = []
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    get() {
      return undefined
    },
    inject(services, callback) {
      const hostCtx = {
        webServer: {
          register(entry) {
            routes.push(entry.path)
            return () => {}
          },
        },
        tools: {
          register(definition) {
            tools.push(definition.name)
            return () => {}
          },
        },
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
      }
      callback(hostCtx)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on() {},
  }

  hostModule.apply(fakeCtx, { threshold: 8 })
  const expectedRoutes = [
    '/hint/list',
    '/hint/push',
    '/hint/read',
    '/hint/clear',
    '/hint/config',
    '/handoff/state',
    '/handoff/prepare',
    '/handoff/consume',
    '/handoff/markdown',
    '/handoff/config',
  ]
  for (const route of expectedRoutes) assert.ok(routes.includes(route), `missing route ${route}`)
  assert.deepEqual([...tools].sort(), ['handoff_now', 'post_hint'])
  ok('both halves mounted: 10 routes + post_hint/handoff_now tools')
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      /* unload cleanup is best effort */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STUB DOM (only the surface lib/client.js actually uses)
// ═══════════════════════════════════════════════════════════════════════════

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentElement = null
    this.attributes = []
    this.style = {}
    this.listeners = Object.create(null)
    this._textContent = ''
    this._className = ''
    this._id = ''
    this.isConnected = true
    this.offsetParent = {}
    this.__rect = null
  }

  get id() {
    return this._id
  }

  set id(value) {
    if (this._id && this.ownerDocument) this.ownerDocument._unregister(this)
    this._id = String(value)
    if (this.ownerDocument) this.ownerDocument._register(this)
  }

  get className() {
    return this._className
  }

  set className(value) {
    this._className = String(value == null ? '' : value)
    this.setAttribute('class', this._className)
  }

  get firstElementChild() {
    return this.children[0] || null
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null
  }

  get textContent() {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('')
    return this._textContent
  }

  set textContent(value) {
    this._textContent = String(value == null ? '' : value)
    for (const child of this.children.slice()) child.remove()
  }

  setAttribute(name, value) {
    const key = String(name)
    const text = String(value)
    const existing = this.attributes.find((entry) => entry.name === key)
    if (existing) existing.value = text
    else this.attributes.push({ name: key, value: text })
    if (key === 'id') this.id = text
    else if (key === 'class') this._className = text
  }

  getAttribute(name) {
    const key = String(name)
    const found = this.attributes.find((entry) => entry.name === key)
    return found ? found.value : null
  }

  removeAttribute(name) {
    const key = String(name)
    this.attributes = this.attributes.filter((entry) => entry.name !== key)
    if (key === 'class') this._className = ''
  }

  appendChild(child) {
    return this.insertBefore(child, null)
  }

  insertBefore(child, reference) {
    if (!child) return child
    if (child.parentElement) child.parentElement._removeChild(child)
    if (reference === null || reference === undefined) {
      this.children.push(child)
      child.parentElement = this
      child._setConnected(true)
      return child
    }
    const index = this.children.indexOf(reference)
    if (index < 0) throw new Error('insertBefore: reference is not a child')
    this.children.splice(index, 0, child)
    child.parentElement = this
    child._setConnected(true)
    return child
  }

  removeChild(child) {
    this._removeChild(child)
    return child
  }

  _removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    if (child.parentElement === this) child.parentElement = null
    child._setConnected(false)
  }

  _setConnected(value) {
    this.isConnected = Boolean(value)
    for (const child of this.children) child._setConnected(value)
  }

  remove() {
    if (this.parentElement) this.parentElement._removeChild(this)
    else this._setConnected(false)
  }

  cloneNode(deep) {
    const clone = this.ownerDocument.createElement(String(this.tagName).toLowerCase())
    clone._className = this._className
    clone._id = ''
    for (const entry of this.attributes) {
      if (entry.name === 'id') continue
      clone.attributes.push({ name: entry.name, value: entry.value })
    }
    clone._textContent = this.children.length === 0 ? this._textContent : ''
    if (deep) {
      for (const child of this.children) clone.appendChild(child.cloneNode(true))
    }
    return clone
  }

  addEventListener(type, handler) {
    const key = String(type)
    if (!this.listeners[key]) this.listeners[key] = []
    this.listeners[key].push(handler)
  }

  removeEventListener(type, handler) {
    const key = String(type)
    if (!this.listeners[key]) return
    this.listeners[key] = this.listeners[key].filter((entry) => entry !== handler)
  }

  dispatchEvent(event) {
    const payload = event || {}
    payload.target = this
    payload.currentTarget = this
    if (typeof payload.preventDefault !== 'function') payload.preventDefault = () => {}
    if (typeof payload.stopPropagation !== 'function') payload.stopPropagation = () => {}
    const handlers = (this.listeners[String(payload.type)] || []).slice()
    for (const handler of handlers) handler(payload)
    return true
  }

  click() {
    return this.dispatchEvent({ type: 'click' })
  }

  focus() {}

  getBoundingClientRect() {
    const rect = this.__rect || { width: 200, height: 36 }
    return { width: rect.width, height: rect.height, top: 0, left: 0, right: rect.width, bottom: rect.height }
  }

  querySelectorAll(selector) {
    const results = []
    const groups = String(selector || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const walk = (node) => {
      for (const child of node.children) {
        for (const group of groups) {
          if (matchesSelector(child, group)) {
            if (!results.includes(child)) results.push(child)
            break
          }
        }
        walk(child)
      }
    }
    walk(this)
    return results
  }

  querySelector(selector) {
    const list = this.querySelectorAll(selector)
    return list[0] || null
  }
}

function parseCompound(compound) {
  const tokens = []
  let index = 0
  while (index < compound.length) {
    const char = compound[index]
    if (char === '#') {
      let end = index + 1
      while (end < compound.length && /[\w-]/.test(compound[end])) end += 1
      tokens.push({ type: 'id', value: compound.slice(index + 1, end) })
      index = end
    } else if (char === '.') {
      let end = index + 1
      while (end < compound.length && /[\w-]/.test(compound[end])) end += 1
      tokens.push({ type: 'class', value: compound.slice(index + 1, end) })
      index = end
    } else if (char === '[') {
      const end = compound.indexOf(']', index)
      const inner = compound.slice(index + 1, end < 0 ? compound.length : end).trim()
      let match = /^([\w-]+)\*=\s*["']?(.*?)["']?$/.exec(inner)
      if (match) tokens.push({ type: 'attr', name: match[1], op: '*=', value: match[2] })
      else {
        match = /^([\w-]+)=\s*["']?(.*?)["']?$/.exec(inner)
        if (match) tokens.push({ type: 'attr', name: match[1], op: '=', value: match[2] })
        else tokens.push({ type: 'attr', name: inner, op: null, value: null })
      }
      index = end < 0 ? compound.length : end + 1
    } else {
      let end = index
      while (end < compound.length && /[\w-]/.test(compound[end])) end += 1
      if (end === index) {
        index += 1
      } else {
        tokens.push({ type: 'tag', value: compound.slice(index, end).toLowerCase() })
        index = end
      }
    }
  }
  return tokens
}

function matchesSelector(element, compound) {
  const tokens = parseCompound(compound)
  if (tokens.length === 0) return false
  for (const token of tokens) {
    if (token.type === 'tag' && String(element.tagName).toLowerCase() !== token.value) return false
    if (token.type === 'id' && element.id !== token.value) return false
    if (token.type === 'class' && String(element.className || '').split(/\s+/).filter(Boolean).indexOf(token.value) === -1) {
      return false
    }
    if (token.type === 'attr') {
      const value = element.getAttribute(token.name)
      if (value === null) return false
      if (token.op === '=' && value !== token.value) return false
      if (token.op === '*=' && !value.includes(token.value)) return false
    }
  }
  return true
}

function createDocument() {
  const doc = {
    _registry: new Map(),
    createElement(tag) {
      return new FakeElement(tag, doc)
    },
    getElementById(id) {
      const element = doc._registry.get(String(id))
      return element && element.isConnected ? element : null
    },
    _register(element) {
      if (element.id) doc._registry.set(element.id, element)
    },
    _unregister(element) {
      if (element.id && doc._registry.get(element.id) === element) doc._registry.delete(element.id)
    },
    querySelectorAll(selector) {
      return doc.body ? doc.body.querySelectorAll(selector) : []
    },
    querySelector(selector) {
      const list = doc.querySelectorAll(selector)
      return list[0] || null
    },
    addEventListener(type, handler) {
      if (!doc._listeners) doc._listeners = Object.create(null)
      if (!doc._listeners[type]) doc._listeners[type] = []
      doc._listeners[type].push(handler)
    },
    removeEventListener(type, handler) {
      if (!doc._listeners || !doc._listeners[type]) return
      doc._listeners[type] = doc._listeners[type].filter((entry) => entry !== handler)
    },
    dispatchEvent(event) {
      const payload = event || {}
      if (typeof payload.preventDefault !== 'function') payload.preventDefault = () => {}
      if (typeof payload.stopPropagation !== 'function') payload.stopPropagation = () => {}
      for (const handler of ((doc._listeners && doc._listeners[payload.type]) || []).slice()) handler(payload)
      return true
    },
    activeElement: null,
  }
  doc.documentElement = new FakeElement('html', doc)
  doc.head = new FakeElement('head', doc)
  doc.body = new FakeElement('body', doc)
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  return doc
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
  }
  observe() {}
  disconnect() {}
}

/** Build the shell sidebar structure the structural probes look for. */
function buildShell(doc) {
  const column = doc.createElement('div')
  column.className = 'wtg9ga_sidebarCol'
  column.__rect = { width: 240, height: 700 }
  const root = doc.createElement('div')
  root.className = 'wtg9ga_root'
  root.__rect = { width: 240, height: 700 }
  const newSession = doc.createElement('button')
  newSession.className = 'wtg9ga_newSession'
  newSession.textContent = '新会话'
  const nav = doc.createElement('nav')
  nav.className = 'wtg9ga_panelList'
  nav.__rect = { width: 240, height: 160 }

  const panelRow = (label) => {
    const row = doc.createElement('button')
    row.className = 'wtg9ga_panelRow'
    const glyph = doc.createElement('span')
    glyph.className = 'wtg9ga_panelGlyph'
    // The real shell renders an SVG icon here; keep the glyph text empty so
    // `textContent` stays exactly the label (the probe is hardened anyway).
    glyph.textContent = ''
    const title = doc.createElement('span')
    title.className = 'wtg9ga_panelTitle'
    title.textContent = label
    row.appendChild(glyph)
    row.appendChild(title)
    return row
  }

  nav.appendChild(panelRow('插件'))
  nav.appendChild(panelRow('自动化任务'))
  const moreRow = panelRow('更多')
  nav.appendChild(moreRow)

  // dsh-project-hub's own entry row (it always sits right after 「更多」).
  const hubRow = doc.createElement('button')
  hubRow.className = 'wtg9ga_panelRow'
  hubRow.id = 'dsh-project-hub-nav-row'
  hubRow.setAttribute('data-project-hub-entry', '1')
  hubRow.appendChild(doc.createElement('span')).textContent = '+'
  const hubLabel = doc.createElement('span')
  hubLabel.textContent = '项目工坊'
  hubRow.appendChild(hubLabel)
  nav.appendChild(hubRow)

  // Another plugin already occupying the next seat (conflict fixture).
  const foreignRow = doc.createElement('button')
  foreignRow.className = 'wtg9ga_panelRow'
  foreignRow.id = 'acme-nav-row'
  foreignRow.setAttribute('data-acme-entry', '1')
  foreignRow.appendChild(doc.createElement('span')).textContent = '◈'
  const foreignLabel = doc.createElement('span')
  foreignLabel.textContent = '另一个插件'
  foreignRow.appendChild(foreignLabel)
  nav.appendChild(foreignRow)

  const footArea = doc.createElement('div')
  footArea.className = 'wtg9ga_footArea'
  root.appendChild(newSession)
  root.appendChild(nav)
  root.appendChild(footArea)
  column.appendChild(root)
  doc.body.appendChild(column)
  return { column, root, nav, moreRow, hubRow, foreignRow }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT-SIDE SMOKE
// ═══════════════════════════════════════════════════════════════════════════

async function clientSmoke() {
  console.log('\n[client] sidebar entry + dialog + handoff + status line')

  const doc = createDocument()
  const shell = buildShell(doc)

  const HINT_TS = new Date(2026, 9, 28, 11, 30, 0).getTime()
  const AUTO_TS = new Date(2026, 9, 28, 12, 4, 0).getTime()
  let hintResponse = {
    ok: true,
    hints: [
      { id: 'h3', title: '构建完成', body: '3 个产物已写入 dist/', level: 'info', ts: HINT_TS, read: false },
      { id: 'h2', title: '压缩提醒', body: '第 3 轮自动压缩已完成', level: 'warn', ts: HINT_TS - 60000, read: true },
      { id: 'h1', title: '旧提示', level: 'error', ts: HINT_TS - 120000, read: true },
    ],
    config: { pollMs: 4000, maxHints: 50, enabled: true },
  }
  let stateResponse = {
    ok: true,
    plugin: 'dsh-hint-handoff',
    version: '0.1.0',
    sessionId: 'sess-1',
    resolvedFrom: 'fallback-latest',
    config: { enabled: true, threshold: 8 },
    compactions: { auto: 3, manual: 1, failed: 0, inFlight: false, threshold: 8 },
    autoHandoff: { enabled: true, lastAt: AUTO_TS },
    modes: [
      { id: 'computer-use', name: 'Computer Use 模式', description: '桌面 GUI 操作', available: true, fullAccess: true },
      { id: 'standard', name: '标准模式', description: '编码、文档、搜索与子代理', available: true, fullAccess: true },
    ],
    safe: true,
    blockReasons: [],
  }
  let prepareResponse = {
    ok: true,
    handoffFile: 'C:\\work\\.dsh-handoff\\HANDOFF-20261028-120500.md',
    newSessionId: 'sess-2',
    mode: 'computer-use',
  }
  const fetchCalls = []
  const prepareBodies = []
  const jsonResponse = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  })
  async function stubFetch(url, init) {
    const target = String(url)
    fetchCalls.push({ url: target, init: init || {} })
    if (target.includes('/hint/list')) return jsonResponse(200, hintResponse)
    if (target.includes('/handoff/state')) return jsonResponse(200, stateResponse)
    if (target.includes('/handoff/prepare')) {
      let body = {}
      try {
        body = JSON.parse((init && init.body) || '{}')
      } catch {
        body = {}
      }
      prepareBodies.push({ url: target, init: init || {}, body })
      return jsonResponse(200, prepareResponse)
    }
    return jsonResponse(404, { ok: false, error: 'not-found' })
  }

  let registered = null
  const windowListeners = Object.create(null)
  const win = {
    location: { protocol: 'http:', host: '127.0.0.1:12216', origin: 'http://127.0.0.1:12216', port: '12216' },
    __DSH_TRANSPORT__: { streamBaseUrl: 'http://127.0.0.1:12216' },
    fetch: stubFetch,
    addEventListener(type, handler) {
      if (!windowListeners[type]) windowListeners[type] = []
      windowListeners[type].push(handler)
    },
    removeEventListener(type, handler) {
      if (!windowListeners[type]) return
      windowListeners[type] = windowListeners[type].filter((entry) => entry !== handler)
    },
    dispatchEvent(event) {
      for (const handler of (windowListeners[event.type] || []).slice()) handler(event)
      return true
    },
    getComputedStyle() {
      return { display: 'block', visibility: 'visible', opacity: '1' }
    },
    __ModuleLoader__: {
      load(registration) {
        registered = registration
      },
    },
  }

  const sandbox = {
    window: win,
    document: doc,
    fetch: stubFetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    console,
    MutationObserver: FakeMutationObserver,
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type
      }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })

  assert.ok(registered, 'client bundle must register with __ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-hint-handoff')
  ok('bundle registered with __ModuleLoader__ under dsh-hint-handoff')

  const client = registered.factory(() => {
    throw new Error('no require() expected')
  })
  assert.equal(typeof client.apply, 'function')
  const t = client.__test__

  // ── apply: mount everything ──────────────────────────────────────────────
  const cleanups = []
  const ctx = {
    effect(fn) {
      // Cordis effect contract: the callback runs immediately and returns the
      // disposer. Mirror that so the unmount assertions exercise real teardown.
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
  }
  client.apply(ctx)
  assert.ok(doc.getElementById(t.PORTAL_HOST_ID), 'portal host exists after apply')
  assert.ok(doc.getElementById(t.DIALOG_ID), 'dialog exists (hidden) after apply')
  assert.equal(doc.getElementById(t.OVERLAY_ID).style.display, 'none')
  const navRow = doc.getElementById(t.NAV_ROW_ID)
  assert.ok(navRow, 'sidebar entry row mounted')
  assert.equal(navRow.getAttribute(t.ENTRY_ATTR), '1')
  assert.equal(navRow.textContent, `${t.ENTRY_GLYPH}${t.ENTRY_LABEL}`)
  ok('apply() mounts portal host + hidden dialog + sidebar entry row')

  // ── insertion: after 项目工坊 AND after the foreign entry row ────────────
  assert.equal(navRow.parentElement, shell.nav, 'entry row lives in the native nav list')
  const order = shell.nav.children.map((child) => child.id || child.textContent)
  assert.ok(order.indexOf('dhh-nav-row') > order.indexOf('dsh-project-hub-nav-row'), 'entry goes after 项目工坊')
  assert.ok(order.indexOf('dhh-nav-row') > order.indexOf('acme-nav-row'), 'entry walks past an occupied data-*-entry seat')
  assert.equal(order.indexOf('dhh-nav-row'), order.indexOf('acme-nav-row') + 1)
  ok('entry seat: after 项目工坊 and after the occupied foreign entry row')

  // ── idempotency ──────────────────────────────────────────────────────────
  t.syncNavEntry()
  t.syncNavEntry()
  const copies = doc.querySelectorAll('#dhh-nav-row')
  assert.equal(copies.length, 1, 're-sync must never duplicate the row')
  ok('re-sync is idempotent (exactly one #dhh-nav-row)')

  // ── anti-flicker guard: a correct seat means ZERO DOM writes ─────────────
  // The old build re-appendChild()-ed the row on EVERY observer tick (the
  // body-wide MutationObserver then saw its own mutation and rescheduled, so
  // the row was removed + re-inserted ~16 times per second => blinking row and
  // replayed native fade-in animation). A re-sync must now be a pure no-op.
  {
    let writes = 0
    const seats = [shell.nav, shell.root]
    const originals = new Map()
    for (const seat of seats) {
      originals.set(seat, {})
      for (const method of ['appendChild', 'insertBefore', 'removeChild']) {
        originals.get(seat)[method] = seat[method]
        seat[method] = function (...args) {
          writes += 1
          return originals.get(seat)[method].apply(this, args)
        }
      }
    }
    try {
      for (let index = 0; index < 5; index += 1) t.syncNavEntry()
    } finally {
      for (const seat of seats) {
        for (const method of ['appendChild', 'insertBefore', 'removeChild']) {
          seat[method] = originals.get(seat)[method]
        }
      }
    }
    assert.equal(writes, 0, 'a re-sync on the correct seat must not write to the DOM')
    assert.equal(doc.querySelectorAll('#dhh-nav-row').length, 1, 'never more than one entry row')
    ok('anti-flicker guard: 5x syncNavEntry() performs ZERO DOM writes')
  }

  // ── self-heal: a React re-render that wipes the row is repaired once ─────
  {
    const wiped = doc.getElementById(t.NAV_ROW_ID)
    wiped.remove()
    t.syncNavEntry()
    const rebuilt = doc.getElementById(t.NAV_ROW_ID)
    assert.ok(rebuilt, 'the entry row is re-mounted after the shell drops it')
    assert.equal(doc.querySelectorAll('#dhh-nav-row').length, 1, 're-mount creates exactly one row')
    assert.equal(rebuilt.parentElement, shell.nav, 're-mount lands back in the native nav list')
    ok('self-heal: a wiped entry row is re-mounted exactly once')
  }

  // ── pure conflict-order helper ───────────────────────────────────────────
  const plainRow = shell.moreRow
  assert.equal(t.findProjectHubRow(Array.from(shell.nav.children)), shell.hubRow)
  assert.equal(t.isForeignEntryRow(shell.hubRow), true)
  assert.equal(t.isForeignEntryRow(shell.foreignRow), true)
  assert.equal(t.isForeignEntryRow(plainRow), false)
  assert.equal(
    t.computeInsertIndex([shell.moreRow, shell.hubRow]),
    2,
    'no conflict: right after 项目工坊',
  )
  assert.equal(
    t.computeInsertIndex([shell.moreRow, shell.hubRow, shell.foreignRow]),
    3,
    'occupied seat: walk down to the next free slot',
  )
  ok('conflict scan: free seat after the LAST entry row, never over another plugin')

  // ── open dialog + refresh: hint list + real status line ─────────────────
  assert.equal(t.openDialog(), true)
  assert.equal(doc.getElementById(t.OVERLAY_ID).style.display, 'flex')
  assert.equal(t.isDialogOpen(), true)
  const refreshed = await waitUntil(() => t.debug().state !== null)
  assert.ok(refreshed, 'dialog refresh reached /handoff/state')
  const messageRows = doc.querySelectorAll('.dhh-message')
  assert.equal(messageRows.length, 3, 'hint list renders the three messages')
  assert.ok(doc.getElementById(t.MESSAGE_LIST_ID).textContent.includes('构建完成'))
  const statusText = doc.getElementById(t.STATUS_ID).textContent
  assert.equal(statusText, '压缩轮数 3/8 · 自动交接 已触发（12:04）')
  ok('dialog opens; hint list + status line render real numbers (3/8 · 已触发 12:04)')

  // ── empty state ──────────────────────────────────────────────────────────
  hintResponse = { ok: true, hints: [], config: { pollMs: 4000 } }
  await t.refresh()
  assert.equal(doc.querySelectorAll('.dhh-message').length, 0)
  assert.equal(doc.getElementById(t.MESSAGE_LIST_ID).textContent, '暂无提示，安静一下。')
  ok('empty state: 「暂无提示，安静一下。」')

  // ── status text variants (real fields, never hard-coded x/y) ────────────
  assert.equal(
    t.computeStatusText({ ok: true, compactions: { auto: 3, threshold: 8 }, config: { enabled: false } }),
    '压缩轮数 3/8 · 自动交接 已关闭',
  )
  assert.equal(
    t.computeStatusText({
      ok: true,
      compactions: { auto: 6, threshold: 8 },
      config: { enabled: true },
      autoHandoff: { enabled: true, lastAt: null },
    }),
    '压缩轮数 6/8 · 自动交接 未触发',
  )
  ok('status line variants: 已关闭 / 未触发 / 已触发（12:04）')

  // ── handoff: button → mode picker → POST prepare(mode) ──────────────────
  hintResponse = {
    ok: true,
    hints: [{ id: 'h3', title: '构建完成', level: 'info', ts: HINT_TS, read: false }],
    config: { pollMs: 4000 },
  }
  await t.refresh()
  const handoffBtn = doc.getElementById(t.HANDOFF_BTN_ID)
  assert.ok(handoffBtn, 'handoff button exists')
  handoffBtn.click()
  const picker = doc.getElementById(t.MODE_PICKER_ID)
  assert.equal(picker.style.display, 'flex', 'mode picker opens on 交接会话')
  const modeButtons = doc.querySelectorAll('[data-dhh-mode]')
  assert.equal(modeButtons.length, 2, 'exactly two modes')
  assert.deepEqual(
    modeButtons.map((button) => button.getAttribute(t.MODE_ATTR)),
    ['computer-use', 'standard'],
  )
  for (const button of modeButtons) {
    assert.ok(button.textContent.includes('完全权限'), `mode ${button.id} must be labelled 完全权限`)
    assert.ok(button.textContent.includes(button.getAttribute(t.MODE_ATTR) === 'computer-use' ? 'Computer Use 模式' : '标准模式'))
  }
  ok('「交接会话」 shows Computer Use / 标准 modes, both labelled 完全权限')

  doc.getElementById('dhh-mode-computer-use').click()
  const posted = await waitUntil(() => prepareBodies.length === 1)
  assert.ok(posted, 'mode click POSTs /handoff/prepare')
  assert.equal(prepareBodies[0].body.force, true)
  assert.equal(prepareBodies[0].body.mode, 'computer-use')
  assert.ok(prepareBodies[0].url.includes('/handoff/prepare'))
  const finished = await waitUntil(() => t.debug().busy === false)
  assert.ok(finished, 'handoff action settles')
  assert.equal(doc.getElementById(t.MODE_PICKER_ID).style.display, 'none', 'picker closes after success')
  assert.ok(doc.getElementById(t.STATUS_ID).textContent.includes('交接完成'), 'status line reports the handoff')
  ok('mode selection triggers the handoff POST and updates the status line')

  // ── unmount: remove only our nodes ──────────────────────────────────────
  for (const cleanup of cleanups) cleanup()
  assert.equal(Boolean(doc.getElementById(t.NAV_ROW_ID)), false, 'our nav row is gone')
  assert.equal(Boolean(doc.getElementById(t.DIALOG_ID)), false, 'our dialog is gone')
  assert.equal(Boolean(doc.getElementById(t.PORTAL_HOST_ID)), false, 'our portal host is gone')
  assert.equal(Boolean(doc.getElementById('dsh-project-hub-nav-row')), true, 'project-hub row survived')
  assert.equal(Boolean(doc.getElementById('acme-nav-row')), true, 'foreign plugin row survived')
  ok('unmount removes only our nodes (project-hub + foreign rows untouched)')
}

// ═══════════════════════════════════════════════════════════════════════════

try {
  await hostSmoke()
  await clientSmoke()
  console.log(`\nSMOKE OK — ${passed} checks passed.`)
} catch (error) {
  console.error('\nSMOKE FAILED')
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
