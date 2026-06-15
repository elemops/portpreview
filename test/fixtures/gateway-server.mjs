import crypto from 'node:crypto'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { parseMessage, PROTOCOL_VERSION, send } from '../../lib/protocol.mjs'

const SUBDOMAIN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * @param {{ port?: number, host?: string, domain?: string }} [options]
 */
export function createGatewayServer(options = {}) {
  const listenPort = options.port ?? 4040
  const listenHost = options.host ?? '127.0.0.1'
  const tunnelDomain = options.domain ?? `localhost:${listenPort}`

  /** @type {Map<string, import('ws').WebSocket>} */
  const tunnels = new Map()
  /** @type {Map<import('ws').WebSocket, string>} */
  const socketSubdomains = new Map()

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

    try {
      const response = await relayHttpRequest(tunnel, req)
      res.writeHead(response.status, response.headers)
      res.end(response.body)
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(err instanceof Error ? err.message : 'Bad gateway')
    }
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/tunnel') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    ws.once('message', (data) => {
      void handleRegister(ws, data)
    })

    ws.on('close', () => {
      const subdomain = socketSubdomains.get(ws)
      if (subdomain) {
        tunnels.delete(subdomain)
        socketSubdomains.delete(ws)
      }
    })
  })

  /**
   * @param {import('ws').WebSocket} ws
   * @param {import('ws').RawData} data
   */
  async function handleRegister(ws, data) {
    try {
      const message = parseMessage(data)
      if (message.type !== 'register') throw new Error('Expected register message')
      if (message.version !== PROTOCOL_VERSION) throw new Error('Unsupported protocol version')

      const requested = message.subdomain ? sanitizeSubdomain(String(message.subdomain)) : undefined
      if (requested === 'gateway') {
        send(ws, { type: 'error', message: 'Subdomain "gateway" is reserved' })
        ws.close()
        return
      }
      const subdomain = requested && !tunnels.has(requested) ? requested : randomSubdomain()

      if (tunnels.has(subdomain)) {
        send(ws, { type: 'error', message: `Subdomain "${subdomain}" is already in use` })
        ws.close()
        return
      }

      tunnels.set(subdomain, ws)
      socketSubdomains.set(ws, subdomain)

      send(ws, {
        type: 'registered',
        subdomain,
        url: tunnelDomain.includes(':')
          ? `http://${subdomain}.${tunnelDomain}`
          : `https://${subdomain}.${tunnelDomain}`,
        port: message.port,
        host: message.host,
      })

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
      if (message.type !== 'response') return
      const id = String(message.id ?? '')
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve({
        status: Number(message.status ?? 502),
        headers: /** @type {Record<string, string>} */ (message.headers ?? {}),
        body: message.body ? Buffer.from(String(message.body), 'base64') : Buffer.alloc(0),
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
      const id = crypto.randomUUID()
      const chunks = []

      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error('Upstream timed out'))
        }, 30_000)

        pending.set(id, { resolve, reject, timer })
        send(tunnel, {
          type: 'request',
          id,
          method: req.method,
          path: req.url,
          headers: Object.fromEntries(
            Object.entries(req.headers).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]],
            ),
          ),
          body: chunks.length ? Buffer.concat(chunks).toString('base64') : undefined,
        })
      })

      req.on('error', reject)
    })
  }

  return {
    listenPort,
    listenHost,
    tunnelDomain,
    async start() {
      await new Promise((resolve) => server.listen(listenPort, listenHost, resolve))
      return {
        httpUrl: `http://${listenHost}:${listenPort}`,
        wsUrl: `ws://${listenHost}:${listenPort}/tunnel`,
      }
    },
    async close() {
      for (const ws of tunnels.values()) {
        ws.close()
      }
      tunnels.clear()
      socketSubdomains.clear()
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer)
      }
      pending.clear()
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
  if (out === 'gateway') return randomSubdomain(length)
  return out
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
