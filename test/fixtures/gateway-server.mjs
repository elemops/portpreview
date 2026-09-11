import crypto from 'node:crypto'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { attachedBody, closeWebSocket, MAX_BODY_BYTES, MAX_FRAME_BYTES, parseMessage, PROTOCOL_VERSION, send } from '../../lib/protocol.mjs'
import { clientIp, previewAccess } from '../../lib/preview-access.mjs'

const SUBDOMAIN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const DEFAULT_MAX_TUNNELS = 500
const DEFAULT_MAX_REQUEST_BODY_BYTES = MAX_BODY_BYTES
const CAPTURE_BYTES = 64 * 1024

/**
 * @typedef {import('./client-info.mjs').TunnelSession} TunnelSession
 */

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   domain?: string,
 *   onTunnelOpen?: (session: TunnelSession) => void | Promise<void>,
 *   onTunnelClose?: (session: TunnelSession) => void | Promise<void>,
 *   onTunnelRequest?: (subdomain: string, req: import('node:http').IncomingMessage) => void | Promise<void>,
 *   authorizeTunnel?: (input: { apiToken: string, subdomain?: string }) => Promise<{ authorized: boolean, userId: string, plan: string, subdomain?: string | null }>,
 *   maxTunnels?: number,
 *   maxRequestBodyBytes?: number,
 *   internalSecret?: string,
 *   trustProxy?: boolean,
 *   sessionLimitsMs?: Record<string, number>,
 *   admitTunnel?: (session: Record<string, unknown>) => Promise<{ expiresAt?: string | null } | void>,
 *   onRequestRecord?: (record: Record<string, unknown>) => void | Promise<void>,
 * }} [options]
 */
export function createGatewayServer(options = {}) {
  const listenPort = options.port ?? 4040
  const listenHost = options.host ?? '127.0.0.1'
  const tunnelDomain = options.domain ?? `localhost:${listenPort}`
  const maxTunnels = options.maxTunnels ?? DEFAULT_MAX_TUNNELS
  const maxRequestBodyBytes = Math.min(options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES, MAX_BODY_BYTES)
  const reservations = new Set()
  const expirationTimers = new Map()

  /** @type {Map<string, import('ws').WebSocket>} */
  const tunnels = new Map()
  /** @type {Map<import('ws').WebSocket, string>} */
  const socketSubdomains = new Map()
  /** @type {Map<string, TunnelSession>} */
  const tunnelSessions = new Map()
  /** @type {Map<string, import('ws').WebSocket>} */
  const publicSockets = new Map()
  /** @type {Map<string, import('ws').WebSocket>} */
  const publicSocketTunnels = new Map()

  /** @param {TunnelSession} session */
  function serializeActiveSession(session) {
    return {
      id: session.id,
      subdomain: session.subdomain,
      url: session.url,
      localHost: session.localHost,
      localPort: session.localPort,
      openedAt: session.openedAt.toISOString(),
      closedAt: null,
      clientIp: session.clientIp,
      country: session.country,
      requestCount: 0,
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/internal/caddy-ask') {
      const domain = (url.searchParams.get('domain') ?? '').toLowerCase()
      if (isAllowedTlsDomain(domain, tunnelDomain, tunnels)) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('OK')
      } else {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('Forbidden')
      }
      return
    }

    const controlHost = isReservedHost(req.headers.host ?? '', tunnelDomain) || (req.headers.host ?? '').split(':')[0] === listenHost
    if (url.pathname === '/internal/replay' && controlHost) {
      await replay(req, res)
      return
    }

    if (url.pathname === '/internal/active-tunnels' && controlHost) {
      if (!internalAuthorized(req)) { res.writeHead(401); res.end('Unauthorized'); return }
      const sessions = [...tunnelSessions.values()].map(serializeActiveSession)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ sessions, updatedAt: new Date().toISOString() }))
      return
    }

    const host = req.headers.host ?? ''
    if (isReservedHost(host, tunnelDomain)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }

    const subdomain = extractSubdomain(host, tunnelDomain)
    if (!subdomain) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('PortPreview gateway — no tunnel for this host')
      return
    }

    const tunnel = tunnels.get(subdomain)
    if (!tunnel || tunnel.readyState !== tunnel.OPEN) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Tunnel offline')
      return
    }

    const accessStatus = await previewAccess(req, tunnelSessions.get(subdomain)?.access, options.trustProxy).catch(() => 403)
    if (accessStatus !== 200) {
      res.writeHead(accessStatus, accessStatus === 401 ? { 'www-authenticate': 'Basic realm="PortPreview", charset="UTF-8"' } : {})
      res.end(accessStatus === 401 ? 'Preview password required' : 'Access denied')
      return
    }

    const startedAt = Date.now()
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) {
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end('Request body too large')
      recordRequest(tunnel, req, null, { status: 413, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Request body too large') }, Date.now() - startedAt)
      return
    }

    if (options.onTunnelRequest) {
      void Promise.resolve(options.onTunnelRequest(subdomain, req)).catch((err) => {
        console.error(`Tunnel request log failed for ${subdomain}:`, err instanceof Error ? err.message : err)
      })
    }

    let body = null
    try {
      body = await readBody(req, maxRequestBodyBytes)
      const response = await relayHttpRequest(tunnel, { method: req.method, path: req.url, headers: req.headers, body })
      res.writeHead(response.status, filterResponseHeaders(response.headers))
      res.end(response.body)
      recordRequest(tunnel, req, body, response, Date.now() - startedAt)
    } catch (err) {
      const status = err && typeof err === 'object' && 'code' in err && err.code === 'BODY_TOO_LARGE'
        ? 413
        : 502
      const response = { status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(err instanceof Error ? err.message : 'Bad gateway') }
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, response.headers)
        res.end(response.body)
      }
      recordRequest(tunnel, req, body, response, Date.now() - startedAt)
    }
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const publicWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY_BYTES,
    handleProtocols(protocols) {
      return protocols.values().next().value
    },
  })

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === '/tunnel' && (isReservedHost(req.headers.host ?? '', tunnelDomain) || (req.headers.host ?? '').split(':')[0] === listenHost)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
      return
    }

    const subdomain = extractSubdomain(req.headers.host ?? '', tunnelDomain)
    const tunnel = subdomain ? tunnels.get(subdomain) : undefined
    if (!tunnel || tunnel.readyState !== tunnel.OPEN) {
      socket.destroy()
      return
    }

    const accessStatus = await previewAccess(req, tunnelSessions.get(subdomain)?.access, options.trustProxy).catch(() => 403)
    if (accessStatus !== 200) {
      socket.end(`HTTP/1.1 ${accessStatus} ${accessStatus === 401 ? 'Unauthorized' : 'Forbidden'}\r\n${accessStatus === 401 ? 'WWW-Authenticate: Basic realm="PortPreview"\r\n' : ''}Connection: close\r\n\r\n`)
      return
    }
    if (socket.destroyed || tunnel.readyState !== tunnel.OPEN) { socket.destroy(); return }
    publicWss.handleUpgrade(req, socket, head, (ws) => {
      const id = crypto.randomUUID()
      publicSockets.set(id, ws)
      publicSocketTunnels.set(id, tunnel)

      sendIfOpen(tunnel, {
        type: 'ws_open',
        id,
        path: req.url,
        headers: Object.fromEntries(
          Object.entries(req.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]],
          ),
        ),
      })

      ws.on('message', (data, isBinary) => {
        if (publicSocketTunnels.get(id) !== tunnel) return
        sendIfOpen(tunnel, { type: 'ws_data', id, isBinary }, Buffer.from(data))
      })

      ws.on('close', (code, reason) => {
        publicSockets.delete(id)
        publicSocketTunnels.delete(id)
        sendIfOpen(tunnel, {
          type: 'ws_close',
          id,
          code,
          reason: reason.toString(),
        })
      })
      ws.on('error', () => {
        publicSockets.delete(id)
        publicSocketTunnels.delete(id)
      })
    })
  })

  wss.on('connection', (ws, req) => {
    if (wss.clients.size > maxTunnels) {
      send(ws, { type: 'error', message: 'Gateway tunnel capacity reached' })
      ws.close(1013, 'Try again later')
      return
    }

    const clientInfo = { ip: clientIp(req, options.trustProxy), country: null }
    const registrationTimeout = setTimeout(() => ws.close(1008, 'Registration timed out'), 10_000)
    ws.once('message', () => clearTimeout(registrationTimeout))
    ws.once('close', () => clearTimeout(registrationTimeout))
    ws.on('error', () => {})

    ws.once('message', (data) => {
      void handleRegister(ws, data, clientInfo)
    })

    ws.on('close', () => {
      const subdomain = socketSubdomains.get(ws)
      if (!subdomain) return

      const session = tunnelSessions.get(subdomain)
      if (tunnels.get(subdomain) === ws) tunnels.delete(subdomain)
      clearTimeout(expirationTimers.get(ws))
      expirationTimers.delete(ws)
      reservations.delete(subdomain)
      socketSubdomains.delete(ws)
      tunnelSessions.delete(subdomain)
      for (const [id, publicTunnel] of publicSocketTunnels) {
        if (publicTunnel !== ws) continue
        publicSocketTunnels.delete(id)
        const publicSocket = publicSockets.get(id)
        publicSockets.delete(id)
        publicSocket?.close(1011, 'Tunnel closed')
      }

      for (const [id, waiter] of pending) {
        if (waiter.tunnel !== ws) continue
        clearTimeout(waiter.timer)
        pending.delete(id)
        waiter.reject(new Error('Tunnel closed'))
      }

      if (session && options.onTunnelClose) {
        session.closedAt = new Date()
        void Promise.resolve(options.onTunnelClose(session)).catch((err) => {
          console.error(`Tunnel close notify failed for ${subdomain}:`, err instanceof Error ? err.message : err)
        })
      }
    })
  })

  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('ws').RawData} data
   * @param {{ ip: string, country: string | null }} clientInfo
   */
  async function handleRegister(ws, data, clientInfo) {
    try {
      const message = parseMessage(data)
      if (message.type !== 'register') throw new Error('Expected register message')
      if (message.version !== PROTOCOL_VERSION) throw new Error('Unsupported protocol version')

      const requested = message.subdomain ? sanitizeSubdomain(String(message.subdomain)) : undefined
      const apiToken = message.apiToken ? String(message.apiToken) : ''
      let identity = null

      if (requested && !apiToken) {
        throw new Error('Reserved subdomains require an authenticated CLI token')
      }
      if (apiToken) {
        if (!options.authorizeTunnel) throw new Error('Authenticated tunnels are not configured')
        identity = await options.authorizeTunnel({ apiToken, subdomain: requested })
        if (!identity?.authorized) throw new Error('Tunnel authorization failed')
      }

      if (message.subdomain && !requested) throw new Error('Invalid subdomain')
      const subdomain = requested ?? availableRandomSubdomain(new Map([...tunnels, ...[...reservations].map((name) => [name, null])]))
      if (tunnels.has(subdomain) || reservations.has(subdomain)) throw new Error(`Subdomain "${subdomain}" is already in use`)
      const plan = identity?.plan ?? 'FREE'
      if (plan === 'FREE' && [...tunnelSessions.values()].some((session) =>
        identity?.userId ? session.userId === identity.userId && !session.workspaceId : !session.userId && session.clientIp === clientInfo.ip
      )) throw new Error('Free plans allow one active tunnel. Stop your existing tunnel first.')
      if (ws.readyState !== ws.OPEN) return
      const limitMs = options.sessionLimitsMs?.[plan] ?? ({ FREE: 2 * 60 * 60 * 1000, PRO: 5 * 60 * 60 * 1000 }[plan] ?? null)
      const url = tunnelDomain.includes(':') ? `http://${subdomain}.${tunnelDomain}` : `https://${subdomain}.${tunnelDomain}`
      const session = {
        id: crypto.randomUUID(), subdomain, url,
        localHost: String(message.host ?? '127.0.0.1'), localPort: Number(message.port ?? 0),
        openedAt: new Date(), expiresAt: limitMs === null ? null : new Date(Date.now() + limitMs).toISOString(),
        clientIp: clientInfo.ip, country: clientInfo.country,
        userId: identity?.userId ?? null, workspaceId: identity?.workspaceId ?? null, apiTokenId: identity?.tokenId ?? null,
        plan, isReserved: Boolean(requested), access: identity?.access ?? {},
      }
      reservations.add(subdomain)
      socketSubdomains.set(ws, subdomain)
      tunnelSessions.set(subdomain, session)
      try {
        const admission = await options.admitTunnel?.(session)
        if (admission?.expiresAt) session.expiresAt = admission.expiresAt
        if (ws.readyState !== ws.OPEN) {
          await options.onTunnelClose?.({ ...session, closedAt: new Date() })
          return
        }
      } catch (error) {
        reservations.delete(subdomain)
        throw error
      }
      reservations.delete(subdomain)
      tunnels.set(subdomain, ws)
      send(ws, { type: 'registered', subdomain, url, port: message.port, host: message.host, expiresAt: session.expiresAt })
      scheduleExpiry(ws, session.expiresAt)
      if (options.onTunnelOpen) {
        void Promise.resolve(options.onTunnelOpen(session)).catch((err) => console.error('Tunnel open notification failed:', err.message))
      }

      ws.on('message', (payload) => {
        void handleClientMessage(ws, payload)
      })
    } catch (err) {
      send(ws, {
        type: 'error',
        message: err instanceof Error ? err.message : 'Registration failed',
      })
      ws.close()
    }
  }

  /** @type {Map<string, { resolve: (value: { status: number, headers: Record<string, string>, body: Buffer }) => void, reject: (reason?: unknown) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()

  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('ws').RawData} data
   */
  function handleClientMessage(ws, data) {
    try {
      const message = parseMessage(data)
      const id = String(message.id ?? '')

      if (message.type === 'ws_data') {
        if (publicSocketTunnels.get(id) !== ws) return
        const publicSocket = publicSockets.get(id)
        if (publicSocket?.readyState === publicSocket?.OPEN) {
          publicSocket.send(attachedBody(message), {
            binary: Boolean(message.isBinary),
          })
        }
        return
      }

      if (message.type === 'ws_close' || message.type === 'ws_error') {
        if (publicSocketTunnels.get(id) !== ws) return
        const publicSocket = publicSockets.get(id)
        publicSockets.delete(id)
        publicSocketTunnels.delete(id)
        if (publicSocket?.readyState === publicSocket?.OPEN) {
          const code = message.type === 'ws_error' ? 1011 : Number(message.code ?? 1000)
          closeWebSocket(publicSocket, code, message.reason)
        }
        return
      }

      if (message.type !== 'response') return
      const waiter = pending.get(id)
      if (!waiter || waiter.tunnel !== ws) return
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve({
        status: Number.isInteger(message.status) && message.status >= 200 && message.status <= 599 ? message.status : 502,
        headers: /** @type {Record<string, string>} */ (message.headers ?? {}),
        body: attachedBody(message),
        truncated: Boolean(message.truncated),
      })
    } catch {
      // ignore malformed client messages
    }
  }

  /**
   * @param {import('ws').WebSocket} tunnel
   * @param {http.IncomingMessage} req
   */
  function relayHttpRequest(tunnel, req) {
    return new Promise((resolve, reject) => {
      if (tunnel.readyState !== tunnel.OPEN) return reject(new Error('Tunnel offline'))
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Upstream timed out'))
      }, 30_000)
      pending.set(id, { resolve, reject, timer, tunnel })
      try {
        send(tunnel, { type: 'request', id, method: req.method, path: req.path, headers: filterRequestHeaders(req.headers) }, req.body)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  function recordRequest(tunnel, req, requestBody, response, durationMs) {
    const session = tunnelSessions.get(socketSubdomains.get(tunnel))
    if (!session?.userId || !options.onRequestRecord) return
    const requestHeaders = captureHeaders(req.headers)
    const responseHeaders = captureHeaders(response.headers)
    const record = {
      sessionId: session.id, userId: session.userId, workspaceId: session.workspaceId,
      subdomain: session.subdomain, method: req.method ?? 'GET', path: String(req.url ?? '/').slice(0, 512),
      status: response.status, durationMs, ip: clientIp(req, options.trustProxy), country: null, at: new Date().toISOString(),
      requestHeaders, responseHeaders,
      requestBody: requestBody?.subarray(0, CAPTURE_BYTES).toString('base64') ?? null,
      responseBody: response.body.subarray(0, CAPTURE_BYTES).toString('base64'),
      requestBodyTruncated: requestBody === null || requestBody.length > CAPTURE_BYTES || String(req.url ?? '/').length > 512 || Object.keys(requestHeaders).length < Object.keys(req.headers).length,
      responseBodyTruncated: response.body.length > CAPTURE_BYTES || Boolean(response.truncated) || Object.keys(responseHeaders).length < Object.keys(response.headers).length,
    }
    void Promise.resolve().then(() => options.onRequestRecord(record)).catch(() => {})
  }

  function stopTunnel(ws, code, reason) {
    for (const [id, owner] of publicSocketTunnels) {
      if (owner === ws) publicSockets.get(id)?.close(1011, 'Tunnel closed')
    }
    ws.close(code, reason)
    const timer = setTimeout(() => ws.terminate(), 1000)
    timer.unref()
  }

  function scheduleExpiry(ws, expiresAt) {
    clearTimeout(expirationTimers.get(ws))
    expirationTimers.delete(ws)
    if (!expiresAt) return
    const timer = setTimeout(() => {
      sendIfOpen(ws, { type: 'error', code: 'SESSION_EXPIRED', message: 'Tunnel session limit reached. Run portpreview again to start a new session.' })
      stopTunnel(ws, 4001, 'Session expired; restart portpreview manually')
    }, Math.max(1, new Date(expiresAt).getTime() - Date.now()))
    timer.unref()
    expirationTimers.set(ws, timer)
  }

  function internalAuthorized(req) {
    if (!options.internalSecret) return false
    const actual = Buffer.from(String(req.headers['x-gateway-secret'] ?? ''))
    const expected = Buffer.from(options.internalSecret)
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  }

  async function replay(req, res) {
    if (!internalAuthorized(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return }
    try {
      const data = JSON.parse((await readBody(req, 256 * 1024)).toString())
      const session = [...tunnelSessions.values()].find((item) => item.id === data.sessionId)
      if (!session || session.userId !== data.userId || (session.workspaceId ?? null) !== (data.workspaceId ?? null)) {
        res.writeHead(404); res.end('Live tunnel session not found'); return
      }
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(data.method) || typeof data.path !== 'string' || !data.path.startsWith('/') || data.path.startsWith('//') || /[\\\r\n\0]/.test(data.path) || data.path.length > 8192) throw new Error('Invalid replay request')
      if (!data.headers || typeof data.headers !== 'object' || Array.isArray(data.headers) || typeof data.body !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.body)) throw new Error('Invalid replay payload')
      const body = Buffer.from(data.body, 'base64')
      if (body.length > CAPTURE_BYTES) throw new Error('Replay body too large')
      const tunnel = tunnels.get(session.subdomain)
      if (!tunnel || tunnel.readyState !== tunnel.OPEN) { res.writeHead(409); res.end('Tunnel offline'); return }
      const startedAt = Date.now()
      const response = await relayHttpRequest(tunnel, { method: data.method, path: data.path, headers: data.headers, body })
      recordRequest(tunnel, { method: data.method, url: data.path, headers: data.headers, socket: req.socket }, body, response, Date.now() - startedAt)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: response.status, headers: captureHeaders(response.headers), body: response.body.subarray(0, CAPTURE_BYTES).toString('base64'), bodyTruncated: response.body.length > CAPTURE_BYTES || Boolean(response.truncated) }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Replay failed' }))
    }
  }

  return {
    listenPort,
    listenHost,
    tunnelDomain,
    activeSessions() { return [...tunnelSessions.values()].filter((session) => tunnels.has(session.subdomain)) },
    updateSessions(updates) {
      for (const update of updates) {
        const session = [...tunnelSessions.values()].find((item) => item.id === update.id)
        if (!session) continue
        const socket = tunnels.get(session.subdomain)
        if (update.plan) session.plan = update.plan
        if (update.endedAt) { if (socket) stopTunnel(socket, 4003, 'Tunnel access revoked') }
        else {
          if (update.access && JSON.stringify(update.access) !== JSON.stringify(session.access)) {
            session.access = update.access
            // A policy change must re-check already connected visitors, not only new handshakes.
            for (const [id, owner] of publicSocketTunnels) {
              if (owner !== socket) continue
              const visitor = publicSockets.get(id)
              publicSocketTunnels.delete(id)
              publicSockets.delete(id)
              sendIfOpen(socket, { type: 'ws_close', id, code: 1008, reason: 'Preview access changed' })
              visitor?.close(1008, 'Preview access changed')
              const timer = setTimeout(() => visitor?.terminate(), 1000)
              timer.unref()
            }
          }
          if (Object.hasOwn(update, 'expiresAt') && update.expiresAt !== session.expiresAt) {
            session.expiresAt = update.expiresAt
            if (socket) scheduleExpiry(socket, session.expiresAt)
          }
        }
      }
    },
    async start() {
      await new Promise((resolve) => server.listen(listenPort, listenHost, resolve))
      return {
        httpUrl: `http://${listenHost}:${server.address().port}`,
        wsUrl: `ws://${listenHost}:${server.address().port}/tunnel`,
      }
    },
    async close() {
      for (const timer of expirationTimers.values()) clearTimeout(timer)
      expirationTimers.clear()
      for (const ws of wss.clients) ws.terminate()
      for (const ws of publicSockets.values()) {
        ws.terminate()
      }
      publicSockets.clear()
      publicSocketTunnels.clear()
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Gateway closed'))
      }
      pending.clear()
      await new Promise((resolve) => publicWss.close(resolve))
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * @param {string} hostHeader
 * @param {string} tunnelDomain
 */
function extractSubdomain(hostHeader, tunnelDomain) {
  const host = hostHeader.split(':')[0]?.toLowerCase() ?? ''
  const [domainHost] = tunnelDomain.toLowerCase().split(':')
  if (!host.endsWith(`.${domainHost}`)) return null
  const subdomain = host.slice(0, -(domainHost.length + 1))
  if (!subdomain || subdomain.includes('.')) return null
  return sanitizeSubdomain(subdomain)
}

/** @param {string} value */
function sanitizeSubdomain(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!cleaned || cleaned.length > 63) return null
  return cleaned
}

function randomSubdomain(length = 5) {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += SUBDOMAIN_CHARS[crypto.randomInt(SUBDOMAIN_CHARS.length)]
  }
  return out
}

/**
 * @param {Map<string, import('ws').WebSocket>} tunnels
 */
function availableRandomSubdomain(tunnels) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = randomSubdomain()
    if (!tunnels.has(candidate)) return candidate
  }
  throw new Error('Unable to allocate a random subdomain')
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** @param {Record<string, string>} headers */
function filterRequestHeaders(headers) {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...String(headers.connection ?? '').toLowerCase().split(',').map(name => name.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    !blocked.has(name.toLowerCase()) && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
    (Array.isArray(value) ? value : [value]).every(item => typeof item === 'string' && !/[\r\n\0]/.test(item))
  ))
}

/** @param {Record<string, string>} headers */
function filterResponseHeaders(headers) {
  return filterRequestHeaders(headers)
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 * @param {unknown} [body]
 */
function sendIfOpen(ws, message, body) {
  if (ws.readyState === ws.OPEN) send(ws, message, body)
}

/**
 * @param {string} hostHeader
 * @param {string} tunnelDomain
 */
function isReservedHost(hostHeader, tunnelDomain) {
  const host = hostHeader.split(':')[0]?.toLowerCase() ?? ''
  const [domainHost] = tunnelDomain.toLowerCase().split(':')
  return host === domainHost || host === `gateway.${domainHost}`
}

/**
 * @param {string} domain
 * @param {string} tunnelDomain
 * @param {Map<string, import('ws').WebSocket>} tunnels
 */
function isAllowedTlsDomain(domain, tunnelDomain, tunnels) {
  if (!domain) return false
  const [domainHost] = tunnelDomain.toLowerCase().split(':')
  if (domain === domainHost || domain === `gateway.${domainHost}`) return true
  const subdomain = extractSubdomain(`${domain}:443`, tunnelDomain)
  if (!subdomain || subdomain === 'gateway') return false
  return tunnels.has(subdomain)
}

function captureHeaders(headers) {
  const captured = {}
  let bytes = 0
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || name.toLowerCase() === 'x-gateway-secret') continue
    if (Object.keys(captured).length >= 100) break
    const text = Array.isArray(value) ? value.join(', ') : String(value)
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text) + 8
    if (bytes > 16 * 1024) break
    captured[name] = Array.isArray(value) ? value.map(String) : text
  }
  return captured
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        const error = new Error('Request body too large')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (bytes <= maxBytes) resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('Request aborted')))
  })
}
