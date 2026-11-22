import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import {
  attachedBody,
  closeWebSocket,
  localGatewayHttpUrl,
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  LEGACY_PROTOCOL_VERSION,
  parseMessage,
  publicUrl,
  PROTOCOL_VERSION,
  send,
} from './protocol.mjs'
import { createHttpStream } from './http-stream.mjs'
import { formatBytes, openLocalTcpStream } from './tcp-client.mjs'
import { beginExchange, declaredBodyBytes } from './inspector-store.mjs'

function abortError() { const error = new Error('Tunnel connection cancelled'); error.name = 'AbortError'; return error }

/** @param {{ host: string, port: number, signal?: AbortSignal }} options */
export function waitForLocalPort({ host, port, signal, scheme = 'http://' }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const socket = net.connect({ host, port })
    const cleanup = () => { signal?.removeEventListener('abort', aborted); socket.setTimeout(0) }
    const aborted = () => { cleanup(); socket.destroy(); reject(abortError()) }
    signal?.addEventListener('abort', aborted, { once: true })
    socket.once('connect', () => { cleanup(); socket.end(); resolve() })
    socket.once('error', err => { cleanup(); reject(new Error(`Nothing is listening on ${scheme}${host}:${port} (${err.message})`)) })
    socket.setTimeout(3000, () => { cleanup(); socket.destroy(); reject(new Error(`Timed out waiting for ${scheme}${host}:${port}`)) })
  })
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 * @returns {Promise<Record<string, unknown>>}
 */
function waitForMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Gateway registration timed out')) }, 10_000)
    /** @param {import('ws').RawData} data */
    const onMessage = (data) => {
      try {
        const message = parseMessage(data)
        if (message.type === type) {
          cleanup()
          resolve(message)
          return
        }
        if (message.type === 'error') {
          cleanup()
          const error = new Error(String(message.message ?? 'Gateway error'))
          error.gatewayCode = message.code
          reject(error)
        }
      } catch (err) {
        cleanup()
        reject(err)
      }
    }

    const onClose = (code) => {
      cleanup()
      const error = new Error('Gateway connection closed before tunnel was ready')
      error.closeCode = code
      reject(error)
    }

    const onError = (err) => {
      cleanup()
      reject(err)
    }

    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

/**
 * @param {import('./config.mjs').TunnelOptions & { signal?: AbortSignal, reconnect?: boolean, reconnectDelayMs?: number, reconnectMaxDelayMs?: number, reconnectJitter?: boolean, onRequest?: (info: { method: string, path: string }) => void, onReconnect?: (info: { url: string, previousUrl: string, subdomain: string, protocolVersion: number, streaming: boolean }) => void }} options
 * @returns {Promise<{ url: string, subdomain: string, streaming: boolean, protocolVersion: number, closed: Promise<unknown>, close: () => Promise<void> }>}
 *
 * Reconnect transient transport failures. Interrupted HTTP requests fail and are
 * never replayed; callers can observe a newly assigned anonymous URL via getters.
 */
export async function openTunnel(options) {
  const controller = new AbortController()
  let stopped = false, current, reconnecting, timer, releaseDelay
  let finishClosed
  const closed = new Promise(resolve => { finishClosed = resolve })
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    releaseDelay?.()
    controller.abort()
    await current?.close()
    await reconnecting
    options.signal?.removeEventListener('abort', externalAbort)
    finishClosed()
  }
  const externalAbort = () => { void stop() }
  if (options.signal?.aborted) throw abortError()
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  try {
    current = await openTunnelConnection({ ...options, signal: controller.signal })
    if (stopped || controller.signal.aborted) { await current.close(); throw abortError() }
  }
  catch (error) { options.signal?.removeEventListener('abort', externalAbort); controller.abort(); throw error }
  const terminal = (detail) => [4000, 4001, 4003, 1002, 1008].includes(detail.code)
  const terminalError = error => [4000, 4001, 4003, 1002, 1008].includes(Number(error.closeCode ?? error.gatewayCode)) || /AUTH|ACCESS_REVOKED|SESSION_EXPIRED|MALFORMED_REGISTER|INVALID_REGISTER|UNSUPPORTED_PROTOCOL/.test(String(error.gatewayCode ?? '')) || /Gateway did not assign|Invalid message|authorization failed|access revoked|Invalid subdomain|Unsupported protocol version|Expected register|Reserved subdomains require|Authenticated tunnels are not configured|TCP tunnels|paid plan/i.test(error.message)
  const watch = connection => {
    void connection.closed.then(detail => {
      if (stopped) return
      if (terminal(detail) || options.reconnect === false) { stopped = true; options.signal?.removeEventListener('abort', externalAbort); finishClosed(detail); return }
      const run = reconnect(connection).finally(() => { if (reconnecting === run) reconnecting = null })
      reconnecting = run
    })
  }
  async function reconnect(previous) {
    if (!options.quiet) console.error('Tunnel disconnected. Reconnecting…')
    let attempt = 0
    while (!stopped) {
      const base = Math.max(1, options.reconnectDelayMs ?? 500)
      const max = Math.max(base, options.reconnectMaxDelayMs ?? 30_000)
      const delay = Math.min(max, base * 2 ** Math.min(attempt++, 10))
      const jitter = options.reconnectJitter === false ? 1 : 0.8 + Math.random() * 0.4
      await new Promise(resolve => { releaseDelay = resolve; timer = setTimeout(resolve, Math.ceil(Math.min(max, delay * jitter))) })
      releaseDelay = null
      if (stopped) break
      try {
        const replacement = await openTunnelConnection({ ...options, signal: controller.signal })
        if (stopped) { await replacement.close(); break }
        current = replacement
        watch(replacement)
        if (options.onReconnect) {
          try {
            void Promise.resolve(options.onReconnect({ url: replacement.url, previousUrl: previous.url, subdomain: replacement.subdomain, protocolVersion: replacement.protocolVersion, streaming: replacement.streaming })).catch(error => console.error(`Reconnect callback failed: ${error.message}`))
          } catch (error) { console.error(`Reconnect callback failed: ${error.message}`) }
        }
        else if (options.quiet) console.log(replacement.url)
        else console.log(`Reconnected. URL: ${replacement.url}`)
        break
      } catch (error) {
        if (stopped || error.name === 'AbortError') break
        if (terminalError(error)) {
          stopped = true
          console.error(`Tunnel reconnect stopped: ${error.message}`)
          options.signal?.removeEventListener('abort', externalAbort)
          finishClosed({ error })
          break
        }
        if (!options.quiet) console.error(`Reconnect failed: ${error.message}`)
      }
    }
  }
  watch(current)
  return {
    get url() { return current.url }, get subdomain() { return current.subdomain },
    get expiresAt() { return current.expiresAt }, get protocolVersion() { return current.protocolVersion },
    get streaming() { return current.streaming },
    get kind() { return current.kind }, get tcpHost() { return current.tcpHost }, get tcpPort() { return current.tcpPort },
    closed, close: stop,
  }
}

async function openTunnelConnection(options) {
  const { host, port, subdomain, apiToken, gatewayUrl, tunnelDomain, quiet, onRequest } = options
  const kind = options.kind === 'tcp' ? 'tcp' : 'http'
  /** @type {Map<string, { socket: import('ws').WebSocket, queue: Array<{ data: Buffer, isBinary: boolean }> }>} */
  const localSockets = new Map()

  const streams = new Map()
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  await waitForLocalPort({ host, port, signal: options.signal, scheme: kind === 'tcp' ? '' : 'http://' })

  const ws = new WebSocket(gatewayUrl, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 10_000 })
  ws.on('error', () => {})
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const aborted = () => ws.terminate()
  options.signal?.addEventListener('abort', aborted, { once: true })
  ws.once('close', () => options.signal?.removeEventListener('abort', aborted))
  if (options.signal?.aborted) ws.terminate()

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
      ws.once('close', () => reject(options.signal?.aborted ? abortError() : new Error('Gateway connection closed before opening')))
    })
  } catch (error) {
    ws.terminate()
    if (options.signal?.aborted) throw abortError()
    throw error
  }

  send(ws, {
    type: 'register',
    version: protocolVersion,
    port,
    host,
    subdomain,
    apiToken,
    ...(kind === 'tcp' ? { kind } : {}),
  })

  let registered
  try { registered = await waitForMessage(ws, 'registered') }
  catch (error) {
    ws.terminate()
    if (options.signal?.aborted) throw abortError()
    if (kind !== 'tcp' && protocolVersion === PROTOCOL_VERSION && /Unsupported protocol version/.test(error.message)) {
      if (!quiet) console.error('Gateway supports legacy v2 only: HTTP bodies remain limited to 1 MiB. Upgrade the gateway for streaming.')
      return openTunnelConnection({ ...options, protocolVersion: LEGACY_PROTOCOL_VERSION })
    }
    throw error
  }
  const assignedSubdomain = String(registered.subdomain ?? '')
  if (!assignedSubdomain) { ws.terminate(); throw new Error('Gateway did not assign a subdomain') }
  // A gateway without TCP support ignores `kind` and would hand back an HTTP tunnel.
  if (kind === 'tcp' && (registered.kind !== 'tcp' || !registered.tcpHost || !Number.isInteger(registered.tcpPort))) {
    ws.terminate()
    throw new Error('This gateway does not support TCP tunnels')
  }
  options.signal?.removeEventListener('abort', aborted)
  if (options.signal?.aborted) { ws.terminate(); throw abortError() }

  const url = kind === 'tcp'
    ? `tcp://${registered.tcpHost}:${registered.tcpPort}`
    : tunnelDomain.includes(':') || tunnelDomain === 'localhost'
      ? localGatewayHttpUrl(assignedSubdomain, tunnelDomain)
      : publicUrl(assignedSubdomain, tunnelDomain)
  const onTcpConnection = (info) => {
    options.onTcpConnection?.(info)
    if (!quiet) console.log(`TCP ${info.remoteAddress ?? 'unknown'} ${(info.durationMs / 1000).toFixed(1)}s in ${formatBytes(info.bytesIn)} out ${formatBytes(info.bytesOut)}${info.error ? ` (${info.error})` : ''}`)
  }

  ws.on('message', (data) => {
    void handleGatewayMessage(ws, data, { host, port, quiet, onRequest, localSockets, streams, streamIdleTimeoutMs: options.streamIdleTimeoutMs, inspector: options.inspector, publicUrl: url, kind, onTcpConnection })
  })

  let alive = true
  ws.on('pong', () => { alive = true })
  const heartbeat = setInterval(() => {
    if (!alive) { ws.terminate(); return }
    alive = false
    if (ws.readyState === ws.OPEN) ws.ping()
  }, options.heartbeatIntervalMs ?? 30_000)
  heartbeat.unref()

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat)
    for (const state of streams.values()) state.channel.cancel(new Error('Gateway connection closed'), false)
    streams.clear()
    for (const connection of localSockets.values()) {
      connection.socket.terminate()
    }
    localSockets.clear()
    if (code === 4001) console.error('\nTunnel session limit reached. Run portpreview again to start a new session.')
    else if (code === 4003) console.error('\nTunnel access revoked. Check your account before restarting.')

  })

  return {
    closed,
    url,
    subdomain: assignedSubdomain,
    expiresAt: registered.expiresAt ?? null,
    protocolVersion: registered.version ?? LEGACY_PROTOCOL_VERSION,
    streaming: Boolean(registered.streaming),
    kind,
    tcpHost: kind === 'tcp' ? String(registered.tcpHost) : null,
    tcpPort: kind === 'tcp' ? registered.tcpPort : null,
    close: async () => {
      await new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve(undefined)
          return
        }
        const deadline = setTimeout(() => ws.terminate(), 1000)
        deadline.unref()
        ws.once('close', () => { clearTimeout(deadline); resolve() })
        if (ws.readyState === ws.CONNECTING) ws.terminate()
        else ws.close()
      })
    },
  }
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {import('ws').RawData} data
 * @param {{
 *   host: string,
 *   port: number,
 *   quiet: boolean,
 *   onRequest?: (info: { method: string, path: string }) => void,
 *   localSockets: Map<string, { socket: import('ws').WebSocket, queue: Array<{ data: Buffer, isBinary: boolean }> }>,
 * }} ctx
 */
async function handleGatewayMessage(ws, data, ctx) {
  let message
  try {
    message = parseMessage(data)
  } catch {
    return
  }

  const id = String(message.id ?? '')

  // A TCP tunnel only carries raw connections; an HTTP tunnel never accepts them.
  if (ctx.kind === 'tcp') {
    if (message.type === 'tcp_open') openLocalTcpStream(ws, message, ctx)
    else if (String(message.type).startsWith('http_') && message.type !== 'http_request') ctx.streams.get(id)?.channel.handle(message)
    return
  }
  if (message.type === 'tcp_open') return

  if (message.type === 'http_request') {
    try { openLocalHttpStream(ws, message, ctx) }
    catch (error) { sendIfOpen(ws, { type: 'http_cancel', id, reason: error.message }) }
    return
  }
  if (String(message.type).startsWith('http_')) {
    ctx.streams.get(id)?.channel.handle(message)
    return
  }

  if (message.type === 'ws_open') {
    openLocalWebSocket(ws, message, ctx)
    return
  }

  if (message.type === 'ws_data') {
    const connection = ctx.localSockets.get(id)
    if (!connection) return
    const frame = {
      data: attachedBody(message),
      isBinary: Boolean(message.isBinary),
    }
    connection.inspect?.frame('in', frame.data.length)
    if (connection.socket.readyState === connection.socket.OPEN) {
      connection.socket.send(frame.data, { binary: frame.isBinary })
    } else if (connection.socket.readyState === connection.socket.CONNECTING) {
      if (connection.queue.reduce((bytes, queued) => bytes + queued.data.length, frame.data.length) > MAX_BODY_BYTES) {
        connection.socket.terminate()
        ctx.localSockets.delete(id)
        sendIfOpen(ws, { type: 'ws_error', id, reason: 'WebSocket buffer limit reached' })
        return
      }
      connection.queue.push(frame)
    }
    return
  }

  if (message.type === 'ws_close') {
    const connection = ctx.localSockets.get(id)
    if (!connection) return
    ctx.localSockets.delete(id)
    connection.inspect?.finish({ closeCode: message.code, closeReason: message.reason })
    const close = () => {
      closeWebSocket(connection.socket, message.code, message.reason)
    }
    if (connection.socket.readyState === connection.socket.CONNECTING) {
      connection.socket.once('open', close)
    } else if (connection.socket.readyState === connection.socket.OPEN) {
      close()
    }
    return
  }

  if (message.type !== 'request') return

  const method = String(message.method ?? 'GET').toUpperCase()
  const path = String(message.path ?? '/')
  const headers = /** @type {Record<string, string>} */ (message.headers ?? {})
  const body = attachedBody(message)
  const requestBody = body.length ? body : undefined

  ctx.onRequest?.({ method, path })
  const startedAt = performance.now()
  const inspect = beginExchange(ctx.inspector, { kind: 'http', method, path, headers: stripHopByHop(headers), publicUrl: ctx.publicUrl, protocolVersion: 2 })
  inspect.requestChunk(body)
  inspect.requestEnd()

  try {
    const response = await forwardToLocal({
      host: ctx.host,
      port: ctx.port,
      method,
      path,
      headers,
      body: requestBody,
    })
    if (!ctx.quiet) logRequest(method, path, response.status, startedAt, response.truncated ? 'truncated to 1MB' : '')
    inspect.response(response.status, response.headers)
    inspect.responseChunk(response.body)
    inspect.finish({ responseTruncated: response.truncated })
    send(
      ws,
      {
        type: 'response',
        id,
        status: response.status,
        headers: response.headers,
        truncated: response.truncated || undefined,
      },
      response.body,
    )
  } catch (err) {
    if (!ctx.quiet) logRequest(method, path, 502, startedAt, localErrorReason(err))
    inspect.response(502, { 'content-type': 'text/plain' })
    inspect.responseChunk(Buffer.from(String(err instanceof Error ? err.message : err)))
    inspect.finish({ error: err, synthetic: true })
    send(
      ws,
      {
        type: 'response',
        id,
        status: 502,
        headers: { 'content-type': 'text/plain' },
      },
      Buffer.from(String(err instanceof Error ? err.message : err)),
    )
  }
}

/**
 * @param {import('ws').WebSocket} gateway
 * @param {Record<string, unknown>} message
 * @param {{
 *   host: string,
 *   port: number,
 *   localSockets: Map<string, { socket: import('ws').WebSocket, queue: Array<{ data: Buffer, isBinary: boolean }> }>,
 * }} ctx
 */
function openLocalHttpStream(ws, message, ctx) {
  const id = String(message.id ?? '')
  if (!id || ctx.streams.has(id)) return
  const method = String(message.method ?? 'GET').toUpperCase()
  const path = String(message.path ?? '/')
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path)) {
    sendIfOpen(ws, { type: 'http_cancel', id, reason: 'Invalid local HTTP path' }); return
  }
  ctx.onRequest?.({ method, path })
  const startedAt = performance.now()
  let logged = false
  const log = (status, note = '') => { if (!ctx.quiet && !logged) { logged = true; logRequest(method, path, status, startedAt, note) } }
  const headers = stripHopByHop(message.headers ?? {})
  const upstream = http.request({ host: ctx.host, port: ctx.port, method, path, headers })
  const inspect = beginExchange(ctx.inspector, { kind: 'http', method, path, headers, publicUrl: ctx.publicUrl, protocolVersion: 3, declaredRequestBytes: declaredBodyBytes(message.headers ?? {}) })
  let localSocket
  upstream.once('socket', socket => { localSocket = socket })
  const channel = createHttpStream({
    ws, id, outgoing: 'response', idleTimeoutMs: ctx.streamIdleTimeoutMs ?? 120_000,
    onReceive: chunk => inspect.requestChunk(chunk),
    onSend: chunk => inspect.responseChunk(chunk),
    onEnd: () => inspect.requestEnd(),
    onError: (error) => { inspect.finish({ error }); upstream.destroy(); ctx.streams.delete(id) },
    onSentEnd: () => {
      if (upstream.writableEnded) inspect.requestEnd()
      inspect.finish()
      channel.stop(); ctx.streams.delete(id)
      if (!upstream.writableFinished) { upstream.destroy(); localSocket?.destroy() }
    },
  })
  ctx.streams.set(id, { channel, upstream })
  upstream.once('response', (response) => {
    try {
      log(response.statusCode ?? 502)
      inspect.response(response.statusCode ?? 502, response.headers, response.rawHeaders)
      send(ws, { type: 'http_response', id, status: response.statusCode ?? 502, headers: stripHopByHop(response.headers) })
      channel.setSource(response)
      response.once('aborted', () => channel.cancel(new Error('Local response aborted')))
    } catch (error) { channel.cancel(error) }
  })
  upstream.on('error', error => { log(502, localErrorReason(error)); channel.cancel(error) })
  try { channel.setDestination(upstream) } catch (error) { inspect.finish({ error }); throw error }
}

function openLocalWebSocket(gateway, message, ctx) {
  const id = String(message.id ?? '')
  if (!id || ctx.localSockets.has(id)) return

  const path = String(message.path ?? '/')
  const headers = /** @type {Record<string, string>} */ (message.headers ?? {})
  const protocol = String(headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .find(Boolean)
  const options = { headers: stripWebSocketHeaders(headers), handshakeTimeout: 10_000, maxPayload: MAX_BODY_BYTES }
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path)) {
    sendIfOpen(gateway, { type: 'ws_error', id, reason: 'Invalid local WebSocket path' })
    return
  }
  const url = new URL(`ws://${net.isIPv6(ctx.host) ? `[${ctx.host}]` : ctx.host}:${ctx.port}${path}`)
  const local = protocol ? new WebSocket(url, protocol, options) : new WebSocket(url, options)
  const inspect = beginExchange(ctx.inspector, { kind: 'websocket', method: 'GET', path, headers: protocol ? { ...options.headers, 'sec-websocket-protocol': protocol } : options.headers, publicUrl: ctx.publicUrl })
  const connection = { socket: local, queue: [], inspect }
  ctx.localSockets.set(id, connection)
  local.once('upgrade', response => inspect.response(101, response.headers, response.rawHeaders))

  local.on('open', () => {
    for (const frame of connection.queue) {
      local.send(frame.data, { binary: frame.isBinary })
    }
    connection.queue.length = 0
  })

  local.on('message', (data, isBinary) => {
    inspect.frame('out', data.length ?? data.byteLength ?? 0)
    sendIfOpen(gateway, { type: 'ws_data', id, isBinary }, Buffer.from(data))
  })

  local.on('close', (code, reason) => {
    inspect.finish({ closeCode: code, closeReason: reason.toString() })
    if (ctx.localSockets.get(id)?.socket !== local) return
    ctx.localSockets.delete(id)
    sendIfOpen(gateway, {
      type: 'ws_close',
      id,
      code,
      reason: reason.toString(),
    })
  })

  local.on('error', (err) => {
    inspect.finish({ error: err })
    sendIfOpen(gateway, {
      type: 'ws_error',
      id,
      reason: err instanceof Error ? err.message : 'Local WebSocket failed',
    })
  })
}

/**
 * @param {{ host: string, port: number, method: string, path: string, headers: Record<string, string>, body?: Buffer }} req
 */
function forwardToLocal(req) {
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        host: req.host,
        port: req.port,
        method: req.method,
        path: req.path,
        headers: stripHopByHop(req.headers),
      },
      (res) => {
        const chunks = []
        let received = 0
        let truncated = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve({
            status: res.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(res.headers).flatMap(([key, value]) =>
                value === undefined ? [] : [[key, value]],
              ),
            ),
            body: Buffer.concat(chunks),
            truncated,
          })
        }
        res.on('data', (chunk) => {
          if (settled) return
          if (received + chunk.length > MAX_BODY_BYTES) {
            chunks.push(chunk.subarray(0, MAX_BODY_BYTES - received))
            received = MAX_BODY_BYTES
            truncated = true
            finish()
            res.destroy()
            return
          }
          chunks.push(chunk)
          received += chunk.length
        })
        res.on('end', finish)
        res.on('error', reject)
      },
    )

    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Local request timed out')))
    upstream.on('error', reject)
    if (req.body?.length) upstream.write(req.body)
    upstream.end()
  })
}

/** @param {Record<string, string>} headers */
function stripHopByHop(headers) {
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
  ])
  for (const name of String(headers.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase())
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())))
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 * @param {unknown} [body]
 */
/** One terminal line per request, printed once the local response status is known: `POST /hook 200 32ms`. */
function logRequest(method, path, status, startedAt, note) {
  const ms = Math.max(0, Math.round(performance.now() - startedAt))
  console.log(`${method} ${path} ${status} ${ms}ms${note ? ` (${note})` : ''}`)
}

function localErrorReason(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ECONNREFUSED') return 'nothing is listening on the local port'
  return code || (error instanceof Error ? error.message : String(error))
}

function sendIfOpen(ws, message, body) {
  if (ws.readyState === ws.OPEN) send(ws, message, body)
}

/** @param {Record<string, string>} headers */
function stripWebSocketHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        ![
          'connection',
          'host',
          'sec-websocket-accept',
          'sec-websocket-extensions',
          'sec-websocket-key',
          'sec-websocket-protocol',
          'sec-websocket-version',
          'upgrade',
        ].includes(key.toLowerCase()),
    ),
  )
}
