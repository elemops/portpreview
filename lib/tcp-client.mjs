import net from 'node:net'
import { createHttpStream } from './http-stream.mjs'

/**
 * Handles `tcp_open` from the gateway: connects to the local port and pipes the public TCP
 * connection through the flow-controlled stream channel (`http_data` / `http_end` frames).
 *
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 * @param {{
 *   host: string,
 *   port: number,
 *   streams: Map<string, { channel: ReturnType<typeof createHttpStream>, upstream: import('node:net').Socket }>,
 *   onTcpConnection?: (info: { remoteAddress: string | null, durationMs: number, bytesIn: number, bytesOut: number, error?: string }) => void,
 * }} ctx
 */
export function openLocalTcpStream(ws, message, ctx) {
  const id = String(message.id ?? '')
  if (!id || ctx.streams.has(id)) return
  const startedAt = performance.now()
  const remoteAddress = typeof message.remoteAddress === 'string' ? message.remoteAddress : null
  const local = net.connect({ host: ctx.host, port: ctx.port, allowHalfOpen: true })
  let sentEnd = false, receivedEnd = false, finished = false, bytesIn = 0, bytesOut = 0
  const finish = (error) => {
    if (finished) return
    finished = true
    ctx.streams.delete(id)
    channel.stop()
    local.destroy()
    ctx.onTcpConnection?.({
      remoteAddress, durationMs: Math.round(performance.now() - startedAt), bytesIn, bytesOut,
      ...(error ? { error: localTcpError(error) } : {}),
    })
  }
  // The gateway owns the idle timeout; the client only mirrors what it is told.
  const channel = createHttpStream({
    ws, id, outgoing: 'response', idleTimeoutMs: 0,
    onReceive: (chunk) => { bytesIn += chunk.length },
    onSend: (chunk) => { bytesOut += chunk.length },
    onError: finish,
    onSentEnd: () => { sentEnd = true; if (receivedEnd) finish() },
    onEnd: () => { receivedEnd = true; if (sentEnd) finish() },
  })
  ctx.streams.set(id, { channel, upstream: local })
  // The destination is set before the socket connects (writes and end() queue until then), so a visitor
  // that half-closes at once is half-closed locally instead of being aborted.
  try { channel.setDestination(local) } catch (error) { channel.cancel(error); return }
  local.once('connect', () => {
    local.setNoDelay(true)
    try { channel.setSource(local) } catch (error) { channel.cancel(error) }
  })
  local.on('error', (error) => channel.cancel(error))
  local.once('close', () => { if (!finished) channel.cancel(new Error('Local connection closed')) })
}

function localTcpError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ECONNREFUSED') return 'nothing is listening on the local port'
  if (error instanceof Error && /idle timeout/i.test(error.message)) return 'idle timeout'
  return code || (error instanceof Error ? error.message : String(error))
}

/** `1.2 KB`, `3.4 MB` for the terminal log. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
