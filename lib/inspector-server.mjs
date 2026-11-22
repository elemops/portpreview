import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { beginExchange, createInspectorStore, DEFAULT_INSPECTOR_PORT, INSPECTOR_LIMITS, summary } from './inspector-store.mjs'
import { renderInspectorPage } from './inspector-ui.mjs'

export { DEFAULT_INSPECTOR_PORT }
/** Ports tried after the requested one before falling back to an ephemeral port. */
const FALLBACK_PORTS = 9
const DECODE_LIMIT = 4 * 1024 * 1024
const MUTATION_BODY_LIMIT = 16 * 1024
/** Bytes of an oversized mutation body read and discarded after the 413, so the client sees the answer. */
const MUTATION_DRAIN_LIMIT = 8 * 1024 * 1024
const SSE_BUFFER_LIMIT = 4 * 1024 * 1024
const UPDATE_COALESCE_MS = 100
const HEARTBEAT_MS = 15_000
const REPLAY_TIMEOUT_MS = 30_000

/** Edited replay (`POST /api/replay`) limits. The body limit is the per-request capture limit. */
export const EDIT_LIMITS = Object.freeze({
  methods: Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  bodyBytes: INSPECTOR_LIMITS.requestBodyLimit,
  // Room for the body as base64 (4/3) or JSON-escaped text (up to 2x for quotes, backslashes and newlines), plus headers.
  requestBytes: 3 * 1024 * 1024,
  pathLength: 8 * 1024,
  headerCount: 200,
  headerBytes: 64 * 1024,
})
const EDIT_FIELDS = new Set(['replayOf', 'method', 'path', 'headers', 'body', 'bodyEncoding'])
/** Always set by the inspector (or Node) for a replay, whatever the captured or edited headers say. */
const REGENERATED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding'])
/** Methods for which Node sends `Content-Length: 0` on an empty body; recorded so the entry shows it. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Local-only inspector UI and API. Binds 127.0.0.1 only, enforces a loopback Host allowlist
 * (DNS rebinding), never sends CORS headers, and requires a custom header, a JSON content type
 * and a same-origin Origin (when present) for state-changing requests. The server and its
 * sockets are unref'd, so it never keeps the process alive.
 *
 * @param {{ store: ReturnType<typeof import('./inspector-store.mjs').createInspectorStore>, target: { host: string, port: number },
 *   port?: number, strictPort?: boolean, getStatus?: () => Record<string, unknown>, log?: (line: string) => void }} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startInspectorServer({ store, target, port = DEFAULT_INSPECTOR_PORT, strictPort = false, getStatus, log } = {}) {
  if (!store) throw new TypeError('startInspectorServer requires a store')
  if (!target?.port) throw new TypeError('startInspectorServer requires a target { host, port }')
  const targetHost = target.host || '127.0.0.1'
  const sockets = new Set()
  const sseClients = new Set()
  const replays = new Set()
  let allowedHosts = new Set()
  let closed = false

  const server = http.createServer((req, res) => {
    try { handle(req, res) }
    catch { fail(res, 500, 'Internal inspector error') }
  })
  server.on('connection', socket => {
    socket.unref()
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.unref()

  const boundPort = await bind(server, port, strictPort)
  allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`])
  const url = `http://127.0.0.1:${boundPort}`

  // Store events -> SSE. `updated` is coalesced per entry so streaming bodies do not flood clients.
  const pendingUpdates = new Set()
  let flushTimer = null
  const flush = () => {
    flushTimer = null
    const ids = [...pendingUpdates]
    pendingUpdates.clear()
    for (const id of ids) {
      const entry = store.get(id)
      if (entry) broadcast('updated', summary(entry))
    }
  }
  const listeners = {
    created: entry => { pendingUpdates.delete(entry.id); broadcast('created', summary(entry), entry.id) },
    updated: entry => {
      pendingUpdates.add(entry.id)
      if (!flushTimer && sseClients.size) { flushTimer = setTimeout(flush, UPDATE_COALESCE_MS); flushTimer.unref() }
      else if (!sseClients.size) pendingUpdates.clear()
    },
    evicted: ids => { for (const id of ids) pendingUpdates.delete(id); broadcast('evicted', { ids }) },
    cleared: () => { pendingUpdates.clear(); broadcast('cleared', {}) },
  }
  const subscriptions = Object.entries(listeners).map(([name, listener]) => [name, (...args) => { try { listener(...args) } catch {} }])
  for (const [name, listener] of subscriptions) store.on(name, listener)
  const heartbeat = setInterval(() => { for (const res of sseClients) write(res, ': ping\n\n') }, HEARTBEAT_MS)
  heartbeat.unref()

  function broadcast(event, data, id) {
    if (!sseClients.size) return
    const message = `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) write(res, message)
  }
  function write(res, text) {
    // A client that stopped reading is dropped; EventSource reconnects and the UI refetches.
    if (res.writableLength > SSE_BUFFER_LIMIT) { res.destroy(); sseClients.delete(res); return }
    res.write(text)
  }

  function handle(req, res) {
    const host = String(req.headers.host ?? '').toLowerCase()
    if (!allowedHosts.has(host)) { fail(res, 403, 'Forbidden host'); return }
    let pathname, query
    try { ({ pathname, searchParams: query } = new URL(req.url ?? '/', 'http://127.0.0.1')) }
    catch { fail(res, 400, 'Bad request'); return }

    if (pathname === '/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'Method not allowed'); return }
      const nonce = crypto.randomBytes(18).toString('base64')
      const html = Buffer.from(renderInspectorPage({ nonce }))
      res.writeHead(200, { ...securityHeaders(nonce), 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length })
      res.end(req.method === 'HEAD' ? undefined : html)
      return
    }
    if (!pathname.startsWith('/api/')) { fail(res, 404, 'Not found'); return }
    // Defence in depth: browsers label cross-origin fetches; other localhost ports are "same-site".
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') { fail(res, 403, 'Cross-origin requests are not allowed'); return }
    // Preflights are never answered, so browsers refuse cross-origin requests with custom headers.
    if (req.method === 'OPTIONS') { fail(res, 405, 'Method not allowed'); return }

    const parts = pathname.split('/').filter(Boolean) // ['api', ...]
    const route = parts.slice(1)
    if (route.length === 1 && route[0] === 'status' && req.method === 'GET') { status(res); return }
    if (route.length === 1 && route[0] === 'events' && req.method === 'GET') { events(req, res, query); return }
    if (route.length === 1 && route[0] === 'replay' && req.method === 'POST') { mutate(req, res, body => editedReplay(res, body), EDIT_LIMITS.requestBytes); return }
    if (route[0] === 'requests') {
      if (route.length === 1 && req.method === 'GET') { list(res, query); return }
      if (route.length === 1 && req.method === 'DELETE') { mutate(req, res, () => { store.clear(); json(res, 200, { ok: true }) }); return }
      const entry = route.length >= 2 && /^\d+$/.test(route[1]) ? store.get(Number(route[1])) : null
      if (route.length >= 2 && !entry) { fail(res, 404, 'Request not found'); return }
      if (route.length === 2 && req.method === 'GET') { json(res, 200, detail(entry)); return }
      if (route.length === 3 && route[2] === 'replay' && req.method === 'POST') { mutate(req, res, () => replay(res, entry)); return }
      if (route.length === 4 && route[2] === 'body' && (route[3] === 'request' || route[3] === 'response') && req.method === 'GET') { download(res, entry, route[3]); return }
    }
    fail(res, req.method === 'GET' ? 404 : 405, req.method === 'GET' ? 'Not found' : 'Method not allowed')
  }

  /** Guards, then reads the JSON body (at most `limit` bytes) and calls `action(bodyBuffer)`. */
  function mutate(req, res, action, limit = MUTATION_BODY_LIMIT) {
    const reason = mutationRejection(req)
    if (reason) { req.resume(); fail(res, 403, reason); return }
    const chunks = []
    let size = 0
    let aborted = false
    const tooLarge = () => { aborted = true; chunks.length = 0; fail(res, 413, `Request body too large (limit ${formatBytes(limit)})`) }
    if (Number(req.headers['content-length']) > limit) tooLarge()
    req.on('data', chunk => {
      size += chunk.length
      // Keep reading a little after the 413 so the client gets the answer instead of a reset.
      if (aborted) { if (size > limit + MUTATION_DRAIN_LIMIT) req.destroy(); return }
      if (size > limit) { tooLarge(); return }
      chunks.push(chunk)
    })
    req.once('end', () => { if (!aborted) { try { action(Buffer.concat(chunks, size)) } catch { fail(res, 500, 'Internal inspector error') } } })
    req.once('error', () => {})
  }

  function status(res) {
    let extra = {}
    try { extra = getStatus?.() ?? {} } catch {}
    json(res, 200, {
      publicUrl: null,
      ...extra,
      target: `http://${net.isIPv6(targetHost) ? `[${targetHost}]` : targetHost}:${target.port}`,
      inspector: { url, port: boundPort, ...store.stats() },
    })
  }

  function list(res, query) {
    const after = toInt(query.get('after'), 0)
    const limit = Math.min(toInt(query.get('limit'), 500), 500)
    json(res, 200, { entries: store.list({ after, limit }).map(summary), stats: store.stats() })
  }

  function events(req, res, query) {
    res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' })
    res.write('retry: 2000\n\n')
    const after = toInt(query.get('after') ?? req.headers['last-event-id'], -1)
    if (after >= 0) for (const entry of store.list({ after })) res.write(`id: ${entry.id}\nevent: created\ndata: ${JSON.stringify(summary(entry))}\n\n`)
    sseClients.add(res)
    res.once('close', () => sseClients.delete(res))
  }

  function download(res, entry, side) {
    const body = store.body(entry, side)
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="request-${entry.id}-${side}.bin"`,
      'Content-Length': body.length,
    })
    res.end(body)
  }

  function replay(res, entry) {
    const blocked = replayBlockedReason(entry)
    if (blocked) { json(res, 409, { error: blocked }); return }
    const body = store.body(entry, 'request')
    forward(res, {
      method: entry.method, path: entry.path, headers: replayHeaders(entry.headers, body.length), body,
      replayOf: entry.id, edited: false, publicUrl: entry.publicUrl, protocolVersion: entry.protocolVersion,
    })
  }

  function editedReplay(res, raw) {
    let input
    try { input = JSON.parse(raw.toString('utf8')) } catch { fail(res, 400, 'The request body must be JSON'); return }
    const parsed = parseEditedRequest(input)
    if (parsed.error) { fail(res, parsed.status, parsed.error); return }
    // An evicted original is fine: the edited request does not depend on it, and the link shows "(evicted)".
    const original = parsed.replayOf === null ? null : store.get(parsed.replayOf)
    if (original?.kind === 'websocket') { fail(res, 400, 'WebSocket connections cannot be replayed'); return }
    forward(res, {
      method: parsed.method, path: parsed.path, headers: editedHeaders(parsed.headers, parsed.method, parsed.body.length), body: parsed.body,
      replayOf: parsed.replayOf, edited: true, publicUrl: original?.publicUrl ?? null, protocolVersion: original?.protocolVersion ?? null,
    })
  }

  /** Send a request straight to the local target, capture it as a replay entry and answer `{ id }`. */
  function forward(res, { method, path, headers, body, replayOf, edited, publicUrl, protocolVersion }) {
    const exchange = beginExchange(store, { kind: 'http', source: 'replay', replayOf, edited, method, path, headers, publicUrl, protocolVersion })
    exchange.requestChunk(body)
    exchange.requestEnd()
    const startedAt = performance.now()
    const label = edited ? 'replay, edited' : 'replay'
    let logged = false
    const logLine = (code, note = '') => {
      if (logged || !log) return
      logged = true
      const ms = Math.max(0, Math.round(performance.now() - startedAt))
      try { log(`${method} ${path} ${code} ${ms}ms (${label}${note ? `, ${note}` : ''})`) } catch {}
    }
    let request
    try {
      request = http.request({ host: targetHost, port: target.port, method, path, headers })
    } catch (error) {
      exchange.finish({ error })
      logLine(502, localErrorReason(error))
      json(res, 200, { id: exchange.id })
      return
    }
    replays.add(request)
    request.once('close', () => replays.delete(request))
    request.setTimeout(REPLAY_TIMEOUT_MS, () => request.destroy(new Error('Local request timed out')))
    request.once('response', response => {
      logLine(response.statusCode ?? 502)
      exchange.response(response.statusCode ?? 502, response.headers, response.rawHeaders)
      response.on('data', chunk => exchange.responseChunk(chunk))
      response.once('end', () => exchange.finish())
      response.once('close', () => { if (!response.complete) exchange.finish({ error: new Error('Local response aborted') }) })
      response.on('error', () => {})
    })
    request.on('error', error => {
      logLine(502, localErrorReason(error))
      exchange.finish({ error })
    })
    request.end(body.length ? body : undefined)
    json(res, 200, { id: exchange.id })
  }

  return {
    url,
    port: boundPort,
    async close() {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (flushTimer) clearTimeout(flushTimer)
      for (const [name, listener] of subscriptions) store.off(name, listener)
      for (const request of replays) request.destroy()
      for (const res of sseClients) res.destroy()
      sseClients.clear()
      const done = new Promise(resolve => server.close(() => resolve()))
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections() // Node >= 18.2
      for (const socket of sockets) socket.destroy()
      await done
    },
  }
}

/**
 * CLI wiring: create a store and bind the server in the background, concurrently with the tunnel.
 * A bind failure prints one warning and turns capture off; it never throws or delays the tunnel.
 * @param {{ host: string, port: number, quiet?: boolean, inspectPort?: number, inspectPortExplicit?: boolean }} options
 * @param {{ version?: string, getTunnel?: () => { url?: string, protocolVersion?: number, streaming?: boolean } | undefined }} [context]
 * @returns {{ store: { begin: Function }, url: Promise<string | null>, close: () => Promise<void> }}
 */
export function startInspector(options, { version, getTunnel } = {}) {
  const store = createInspectorStore()
  let enabled = true
  let closing = false
  const port = options.inspectPort ?? DEFAULT_INSPECTOR_PORT
  const started = Promise.resolve().then(() => startInspectorServer({
    store,
    target: { host: options.host, port: options.port },
    port,
    strictPort: Boolean(options.inspectPortExplicit),
    log: options.quiet ? undefined : line => console.log(line),
    getStatus: () => {
      const tunnel = getTunnel?.()
      return { version: version ?? null, publicUrl: tunnel?.url ?? null, protocolVersion: tunnel?.protocolVersion ?? null, streaming: tunnel?.streaming ?? null }
    },
  })).then(server => {
    if (closing) { void server.close(); return null }
    return server
  }, error => {
    enabled = false
    store.clear()
    const reason = error?.code === 'EADDRINUSE' ? `port ${port} is in use` : error?.code === 'EACCES' ? `port ${port} is not permitted` : String(error?.message ?? error)
    console.error(options.inspectPortExplicit
      ? `Inspector disabled: ${reason}. Pick another --inspect-port, or use --no-inspect.`
      : `Inspector disabled: ${reason}.`)
    return null
  })
  return {
    // The tunnel only needs begin(); capture stops if the server could not start.
    store: { begin: info => (enabled && !closing ? store.begin(info) : null) },
    url: started.then(server => server?.url ?? null),
    async close() {
      closing = true
      const server = await started
      await server?.close()
    },
  }
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve(server.address().port) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host: '127.0.0.1' })
  })
}

/** Try the requested port, then the next few, then an ephemeral port. A strict port never falls back. */
async function bind(server, port, strict) {
  const candidates = [port]
  if (!strict && port !== 0) {
    for (let next = port + 1; next <= Math.min(65535, port + FALLBACK_PORTS); next++) candidates.push(next)
    candidates.push(0)
  }
  let lastError
  for (const candidate of candidates) {
    try { return await listenOnce(server, candidate) }
    catch (error) {
      lastError = error
      if (strict || !['EADDRINUSE', 'EACCES'].includes(error.code)) throw error
    }
  }
  throw lastError
}

/** Why a captured request cannot be replayed, or null when it can. */
export function replayBlockedReason(entry) {
  if (entry.kind === 'websocket') return 'WebSocket connections cannot be replayed'
  if (!entry.done) return 'The request is still in flight'
  if (entry.request.truncated) return 'The request body was only partially captured'
  if (!entry.request.complete) return 'The request body never finished arriving'
  return null
}

/** Captured headers with Content-Length regenerated from the retained body, in the original position. */
function replayHeaders(captured, length) {
  const headers = {}
  let sawLength = false
  for (const [name, value] of Object.entries(captured)) {
    if (name.toLowerCase() === 'content-length') { sawLength = true; headers[name] = String(length); continue }
    headers[name] = value
  }
  if (!sawLength && length > 0) headers['content-length'] = String(length)
  return headers
}

/**
 * Validate a `POST /api/replay` body. Returns `{ error, status }` or
 * `{ replayOf, method, path, headers: [name, value][], body: Buffer }`.
 */
export function parseEditedRequest(input) {
  const invalid = (error, status = 400) => ({ error, status })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('The request body must be a JSON object')
  for (const key of Object.keys(input)) {
    if (!EDIT_FIELDS.has(key)) return invalid(`Unknown field ${quote(key)}; expected ${[...EDIT_FIELDS].join(', ')}`)
  }
  const { replayOf = null, method, path, headers = [], body = '', bodyEncoding = 'text' } = input

  if (replayOf !== null && !(Number.isSafeInteger(replayOf) && replayOf > 0)) return invalid('replayOf must be the numeric id of a captured request, or null')
  if (typeof method !== 'string' || !EDIT_LIMITS.methods.includes(method)) return invalid(`method must be one of ${EDIT_LIMITS.methods.join(', ')}`)

  if (typeof path !== 'string' || !path.startsWith('/')) return invalid('path must start with "/"')
  if (path.startsWith('//')) return invalid('path must start with a single "/", not "//"')
  if (path.length > EDIT_LIMITS.pathLength) return invalid(`path is longer than ${EDIT_LIMITS.pathLength} characters`)
  if (/[\r\n\0]/.test(path)) return invalid('path must not contain CR, LF or NUL')
  if (path.includes('\\')) return invalid('path must not contain a backslash')
  if (/[^\x21-\x7e\x80-\xff]/.test(path)) return invalid('path must not contain spaces, control characters or characters outside Latin-1; percent-encode them')

  let pairs
  if (Array.isArray(headers)) pairs = headers
  else if (headers && typeof headers === 'object') pairs = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => [name, item]))
  else return invalid('headers must be a list of [name, value] pairs or an object')
  if (pairs.length > EDIT_LIMITS.headerCount) return invalid(`Too many headers (${pairs.length}; the limit is ${EDIT_LIMITS.headerCount})`)
  let headerBytes = 0
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      return invalid('Each header must be a [name, value] pair of strings')
    }
    const [name, value] = pair
    if (!TOKEN.test(name)) return invalid(`Invalid header name ${quote(name)}: use only letters, digits and !#$%&'*+-.^_\`|~`)
    if (/[\r\n\0]/.test(value)) return invalid(`Header ${quote(name)}: the value must not contain CR, LF or NUL`)
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) return invalid(`Header ${quote(name)}: the value must not contain control characters or characters outside Latin-1`)
    headerBytes += name.length + value.length + 4
  }
  if (headerBytes > EDIT_LIMITS.headerBytes) return invalid(`Headers are larger than ${formatBytes(EDIT_LIMITS.headerBytes)} in total`)

  if (bodyEncoding !== 'text' && bodyEncoding !== 'base64') return invalid('bodyEncoding must be "text" or "base64"')
  let bytes
  if (body === null) bytes = Buffer.alloc(0)
  else if (typeof body !== 'string') return invalid('body must be a string (text, or base64 with bodyEncoding "base64")')
  else if (bodyEncoding === 'text') {
    if (Buffer.byteLength(body, 'utf8') > EDIT_LIMITS.bodyBytes) return invalid(`The body is larger than ${formatBytes(EDIT_LIMITS.bodyBytes)}`, 413)
    bytes = Buffer.from(body, 'utf8')
  } else {
    if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return invalid('body is not valid base64')
    if ((body.length / 4) * 3 - (body.match(/=*$/)[0].length) > EDIT_LIMITS.bodyBytes) return invalid(`The body is larger than ${formatBytes(EDIT_LIMITS.bodyBytes)}`, 413)
    bytes = Buffer.from(body, 'base64')
  }

  return { replayOf, method, path, headers: pairs, body: bytes }
}

/**
 * Outgoing headers for an edited replay: names keep the client's casing and order, repeated names
 * become one array (sent as separate lines), and the regenerated headers are dropped. Content-Length
 * is the body length, kept where the client listed it.
 */
function editedHeaders(pairs, method, length) {
  const headers = {}
  const keys = new Map()
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase()
    if (lower === 'content-length') { if (!keys.has(lower)) { keys.set(lower, name); headers[name] = '' } continue }
    if (REGENERATED_HEADERS.has(lower)) continue
    const key = keys.get(lower)
    if (key === undefined) { keys.set(lower, name); headers[name] = value }
    else headers[key] = [].concat(headers[key], value)
  }
  if (keys.has('content-length')) headers[keys.get('content-length')] = String(length)
  else if (length > 0 || BODY_METHODS.has(method)) headers['content-length'] = String(length)
  return headers
}

function quote(value) {
  const text = JSON.stringify(String(value))
  return text.length > 66 ? `${text.slice(0, 64)}…"` : text
}

function formatBytes(bytes) {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`
}

function mutationRejection(req) {
  if (req.headers['x-portpreview-inspector'] !== '1') return 'Missing X-PortPreview-Inspector header'
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return 'Content-Type must be application/json'
  const origin = req.headers.origin
  if (origin !== undefined && String(origin).toLowerCase() !== `http://${String(req.headers.host).toLowerCase()}`) return 'Origin not allowed'
  return null
}

function detail(entry) {
  const base = summary(entry)
  const requestBody = bodyDetail(entry.request, entry.request.chunks, header(entry.headers, 'content-encoding'))
  const responseBody = bodyDetail(entry.response, entry.response.chunks, header(entry.responseHeaders, 'content-encoding'))
  return {
    ...base,
    replayable: replayBlockedReason(entry) === null,
    replayBlockedReason: replayBlockedReason(entry),
    request: { ...base.request, headers: headerPairs(entry.headers), contentType: header(entry.headers, 'content-type'), ...requestBody },
    response: {
      ...base.response,
      headers: entry.responseRawHeaders ? rawPairs(entry.responseRawHeaders) : headerPairs(entry.responseHeaders ?? {}),
      contentType: header(entry.responseHeaders, 'content-type'),
      ...responseBody,
    },
  }
}

function bodyDetail(body, chunks, encoding) {
  const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, body.retained)
  const result = { base64: bytes.toString('base64') }
  const decoded = decodeBody(bytes, encoding, Boolean(body.truncated) || !body.complete)
  if (decoded) Object.assign(result, decoded)
  return result
}

/** Display-only decoding of compressed bodies; raw bytes are always kept and downloadable. */
function decodeBody(bytes, encoding, partial) {
  const name = String(encoding ?? '').trim().toLowerCase()
  if (!bytes.length || !name || name === 'identity') return null
  const options = { maxOutputLength: DECODE_LIMIT }
  try {
    let decoded
    if (name === 'gzip' || name === 'x-gzip') decoded = zlib.gunzipSync(bytes, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH })
    else if (name === 'deflate') {
      try { decoded = zlib.inflateSync(bytes, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH }) }
      catch { decoded = zlib.inflateRawSync(bytes, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH }) }
    } else if (name === 'br') decoded = zlib.brotliDecompressSync(bytes, { ...options, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
    else return { contentEncoding: name, decodeError: `Content-Encoding "${name}" is shown undecoded` }
    return { contentEncoding: name, decodedBase64: decoded.toString('base64'), decodedPartial: partial }
  } catch (error) {
    const tooLarge = error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError
    return { contentEncoding: name, decodeError: tooLarge ? 'Decoded body is larger than 4 MiB; download the raw bytes instead' : `Could not decode ${name}: ${error.message}` }
  }
}

function header(headers, name) {
  if (!headers) return null
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(', ') : String(value)
  }
  return null
}

function headerPairs(headers) {
  return Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter(item => item !== undefined).map(item => [name, String(item)]))
}

function rawPairs(raw) {
  const pairs = []
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]])
  return pairs
}

function securityHeaders(nonce = crypto.randomBytes(18).toString('base64')) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
  }
}

function json(res, statusCode, value) {
  if (res.headersSent || res.destroyed) return
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(statusCode, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

function fail(res, statusCode, message) { json(res, statusCode, { error: message }) }

function toInt(value, fallback) {
  const number = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function localErrorReason(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ECONNREFUSED') return 'nothing is listening on the local port'
  return code || (error instanceof Error ? error.message : String(error))
}
