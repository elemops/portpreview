import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import {
  attachedBody,
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
 * @param {string} type
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

  const registered = await waitForMessage(ws, 'registered')
  const assignedSubdomain = String(registered.subdomain ?? '')
  if (!assignedSubdomain) throw new Error('Gateway did not assign a subdomain')

  const url =
    tunnelDomain.includes(':') || tunnelDomain === 'localhost'
      ? localGatewayHttpUrl(assignedSubdomain, tunnelDomain)
      : publicUrl(assignedSubdomain, tunnelDomain)

  ws.on('message', (data) => {
    void handleGatewayMessage(ws, data, { host, port, quiet, onRequest })
  })

  ws.on('close', () => {
    if (!quiet) console.log('\nTunnel closed.')
  })

  return {
    url,
    subdomain: assignedSubdomain,
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
 * @param {{ host: string, port: number, quiet: boolean, onRequest?: (info: { method: string, path: string }) => void }} ctx
 */
async function handleGatewayMessage(ws, data, ctx) {
  let message
  try {
    message = parseMessage(data)
  } catch {
    return
  }

  if (message.type !== 'request') return

  const id = String(message.id ?? '')
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
                value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]],
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
      },
    )

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
