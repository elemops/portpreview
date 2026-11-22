import { attachedBody, encodeFrame, send, STREAM_CHUNK_BYTES, STREAM_WINDOW_BYTES } from './protocol.mjs'

/** Bounded HTTP pipe. Credits return only after the destination flushes its write.
 * The readable is pulled in <=64KiB pieces; at most 256KiB is in flight per direction.
 * Neither byte count nor elapsed transfer duration limits a stream.
 */
export function createHttpStream({ ws, id, outgoing, onError, onEnd, onSentEnd, onSend, onReceive, idleTimeoutMs = 120_000, destroyOnError = true }) {
  const incoming = outgoing === 'request' ? 'response' : 'request'
  let source, destination, credit = 0, available = STREAM_WINDOW_BYTES
  let pumping = false, sentEnd = false, receivedEnd = false, closed = false
  let timer
  const activity = () => {
    clearTimeout(timer)
    if (idleTimeoutMs > 0 && !closed) {
      timer = setTimeout(() => fail(new Error('HTTP stream idle timeout')), idleTimeoutMs)
      timer.unref()
    }
  }
  const control = (message) => {
    if (ws.readyState !== ws.OPEN) throw new Error('Tunnel offline')
    send(ws, { ...message, id })
    activity()
  }
  const fail = (error, notify = true) => {
    if (closed) return
    if (notify && ws.readyState === ws.OPEN) send(ws, { type: 'http_cancel', id, reason: error.message })
    stop()
    onError?.(error)
    if (destroyOnError) { source?.destroy(); destination?.destroy() }
  }
  function stop() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    source?.off('readable', pump)
    source?.off('end', pump)
    source?.off('error', fail)
    // Aborted IncomingMessages can emit ECONNRESET after their aborted event.
    source?.once('error', () => {})
    destination?.off('error', fail)
  }
  async function pump() {
    if (pumping || closed || sentEnd || !source) return
    pumping = true
    try {
      source.read(0)
      while (!closed && credit > 0) {
        // IncomingMessage.read(n) may wait for n bytes. read() then split would
        // retain an arbitrarily sized custom source chunk; cap the pull instead.
        const size = Math.min(credit, STREAM_CHUNK_BYTES, source.readableLength)
        if (!size) break
        const chunk = source.read(size)
        if (!chunk) break
        credit -= chunk.length
        onSend?.(chunk)
        const frame = encodeFrame({ type: 'http_data', id, direction: outgoing }, chunk)
        await new Promise((resolve, reject) => ws.send(frame, { binary: true }, (error) => error ? reject(error) : resolve()))
        activity()
      }
      if (!closed && source.readableEnded && source.readableLength === 0) {
        sentEnd = true
        control({ type: 'http_end', direction: outgoing })
        onSentEnd?.()
      }
    } catch (error) { fail(error) }
    finally { pumping = false }
  }
  activity()
  return {
    setSource(readable) {
      source = readable
      readable.on('readable', pump)
      readable.on('end', pump)
      readable.on('error', fail)
      void pump()
    },
    setDestination(writable) {
      destination = writable
      writable.on('error', fail)
      control({ type: 'http_credit', direction: incoming, bytes: STREAM_WINDOW_BYTES })
    },
    handle(message) {
      if (closed) return
      activity()
      if (message.type === 'http_cancel') { fail(new Error(String(message.reason ?? 'HTTP stream cancelled')), false); return }
      if (message.type === 'http_credit') {
        if (message.direction !== outgoing || !Number.isInteger(message.bytes) || message.bytes <= 0 || credit + message.bytes > STREAM_WINDOW_BYTES) {
          fail(new Error('Invalid HTTP stream credit')); return
        }
        credit += message.bytes
        void pump()
      } else if (message.type === 'http_data') {
        const chunk = attachedBody(message)
        if (message.direction !== incoming || !destination || receivedEnd || !chunk.length || chunk.length > STREAM_CHUNK_BYTES || chunk.length > available) {
          fail(new Error('Invalid HTTP stream data')); return
        }
        available -= chunk.length
        onReceive?.(chunk)
        destination.write(chunk, (error) => {
          if (error) { fail(error); return }
          if (closed || receivedEnd) return
          available += chunk.length
          try { control({ type: 'http_credit', direction: incoming, bytes: chunk.length }) } catch (error) { fail(error) }
        })
      } else if (message.type === 'http_end') {
        if (message.direction !== incoming || !destination || receivedEnd) { fail(new Error('Invalid HTTP stream end')); return }
        receivedEnd = true
        destination.end(() => onEnd?.())
      }
    },
    cancel: fail,
    stop,
    touch: activity,
  }
}

/** Capture only a preview; never retain the full streaming body. */
export function createBodyPreview(limit = 64 * 1024) {
  const chunks = []
  let retained = 0, bytes = 0n
  return {
    add(chunk) {
      bytes += BigInt(chunk.length)
      if (retained < limit) {
        const part = chunk.subarray(0, limit - retained)
        chunks.push(Buffer.from(part))
        retained += part.length
      }
    },
    get bytes() { return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : bytes.toString() },
    get truncated() { return bytes > BigInt(retained) },
    body() { return Buffer.concat(chunks, retained) },
  }
}
