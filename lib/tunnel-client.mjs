import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import {
  attachedBody,
  closeWebSocket,
  localGatewayHttpUrl,
  MAX_BODY_BYTES,
  parseMessage,
  publicUrl,
  PROTOCOL_VERSION,
  send,
} from './protocol.mjs'

/**
 * @param {{ host: string, port: number }} options
 * @returns {Promise<void>}
 */
export function waitForLocalPort({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
    socket.once('error', (err) => {
      reject(new Error(`Nothing is listening on http://${host}:${port} (${err.message})`))
    })
    socket.setTimeout(3000, () => {
      socket.destroy()
      reject(new Error(`Timed out waiting for http://${host}:${port}`))
    })
  })
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 * @returns {Promise<Record<string, unknown>>}
 */
function waitForMessage(ws, type) {
  return new Promise((resolve, reject) => {
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
          reject(new Error(String(message.message ?? 'Gateway error')))
        }
      } catch (err) {
        cleanup()
        reject(err)
      }
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Gateway connection closed before tunnel was ready'))
    }

    const onError = (err) => {
      cleanup()
      reject(err)
    }

    const cleanup = () => {
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
 * @param {import('./config.mjs').TunnelOptions & { onRequest?: (info: { method: string, path: string }) => void }} options
 * @returns {Promise<{ url: string, subdomain: string, close: () => Promise<void> }>}
 */
export async function openTunnel(options) {
  const { host, port, subdomain, apiToken, gatewayUrl, tunnelDomain, quiet, onRequest } = options
  /** @type {Map<string, { socket: import('ws').WebSocket, queue: Array<{ data: Buffer, isBinary: boolean }> }>} */
  const localSockets = new Map()

  await waitForLocalPort({ host, port })

  const ws = new WebSocket(gatewayUrl)

  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  send(ws, {
    type: 'register',
    version: PROTOCOL_VERSION,
    port,
    host,
    subdomain,
    apiToken,
  })

  let registered
  try { registered = await waitForMessage(ws, 'registered') }
  catch (error) { ws.close(); throw error }
  const assignedSubdomain = String(registered.subdomain ?? '')
  if (!assignedSubdomain) throw new Error('Gateway did not assign a subdomain')

  const url =
    tunnelDomain.includes(':') || tunnelDomain === 'localhost'
      ? localGatewayHttpUrl(assignedSubdomain, tunnelDomain)
      : publicUrl(assignedSubdomain, tunnelDomain)

  ws.on('message', (data) => {
    void handleGatewayMessage(ws, data, { host, port, quiet, onRequest, localSockets })
  })

  ws.on('close', (code, reason) => {
    for (const connection of localSockets.values()) {
      connection.socket.terminate()
    }
    localSockets.clear()
    if (code === 4001) console.error('\nTunnel session limit reached. Run portpreview again to start a new session.')
    else if (code === 4003) console.error('\nTunnel access revoked. Check your account before restarting.')
    else if (!quiet) console.log('\nTunnel closed.')
  })

  return {
    url,
    subdomain: assignedSubdomain,
    expiresAt: registered.expiresAt ?? null,
    close: async () => {
      await new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve(undefined)
          return
        }
        ws.once('close', resolve)
        ws.close()
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
  if (!ctx.quiet) {
    console.log(`${method} ${path}`)
  }

  try {
    const response = await forwardToLocal({
      host: ctx.host,
      port: ctx.port,
      method,
      path,
      headers,
      body: requestBody,
    })
    if (!ctx.quiet && response.truncated) {
      console.log(`${method} ${path} (truncated to 1MB)`)
    }
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
function openLocalWebSocket(gateway, message, ctx) {
  const id = String(message.id ?? '')
  if (!id || ctx.localSockets.has(id)) return

  const path = String(message.path ?? '/')
  const headers = /** @type {Record<string, string>} */ (message.headers ?? {})
  const protocol = String(headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .find(Boolean)
  const options = { headers: stripWebSocketHeaders(headers), handshakeTimeout: 10_000 }
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path)) {
    sendIfOpen(gateway, { type: 'ws_error', id, reason: 'Invalid local WebSocket path' })
    return
  }
  const url = new URL(`ws://${ctx.host}:${ctx.port}${path}`)
  const local = protocol ? new WebSocket(url, protocol, options) : new WebSocket(url, options)
  const connection = { socket: local, queue: [] }
  ctx.localSockets.set(id, connection)

  local.on('open', () => {
    for (const frame of connection.queue) {
      local.send(frame.data, { binary: frame.isBinary })
    }
    connection.queue.length = 0
  })

  local.on('message', (data, isBinary) => {
    sendIfOpen(gateway, { type: 'ws_data', id, isBinary }, Buffer.from(data))
  })

  local.on('close', (code, reason) => {
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
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
  ])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())))
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 * @param {unknown} [body]
 */
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
