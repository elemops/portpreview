import { EventEmitter } from 'node:events'

const MiB = 1024 * 1024

/** Default inspector port on 127.0.0.1 (4040 is the dev gateway and ngrok). Busy ports fall back to the next ones. */
export const DEFAULT_INSPECTOR_PORT = 4041

/** Phase 1 limits: 200 entries, 32 MiB of retained bodies, 1 MiB per request body, 256 KiB per response body. */
export const INSPECTOR_LIMITS = Object.freeze({
  maxEntries: 200,
  maxBytes: 32 * MiB,
  requestBodyLimit: MiB,
  responseBodyLimit: 256 * 1024,
})

const NOOP_EXCHANGE = Object.freeze({
  id: null,
  requestChunk() {}, requestEnd() {}, response() {}, responseChunk() {}, frame() {}, finish() {},
})

/**
 * In-memory capture of the HTTP requests and WebSocket connections that reached this CLI.
 * Bodies are copied (never retained as views into tunnel frames) and bounded by per-body
 * limits plus a global byte budget that includes in-flight entries. Completed entries are
 * evicted oldest-first by count and by bytes; in-flight entries are never evicted.
 * Emits `created`, `updated` (entry), `evicted` (ids) and `cleared`.
 */
export function createInspectorStore(options = {}) {
  const limits = { ...INSPECTOR_LIMITS }
  for (const key of Object.keys(INSPECTOR_LIMITS)) {
    if (Number.isSafeInteger(options[key]) && options[key] >= 0) limits[key] = options[key]
  }
  const events = new EventEmitter()
  events.setMaxListeners(0)
  /** Insertion order is id order, so iteration is oldest-first. */
  const entries = new Map()
  let nextId = 1
  let usedBytes = 0

  const newBody = limit => ({ chunks: [], retained: 0, bytes: 0, limit, truncated: false, complete: false })
  const emit = (name, value) => { events.emit(name, value) }

  function remove(entry) {
    entries.delete(entry.id)
    entry.removed = true
    usedBytes -= entry.request.retained + entry.response.retained
    entry.request.chunks = []
    entry.response.chunks = []
  }

  /** Evict completed entries oldest-first until `needed` more bytes fit, or nothing is left to evict. */
  function evictForBytes(needed) {
    const evicted = []
    for (const entry of entries.values()) {
      if (usedBytes + needed <= limits.maxBytes) break
      if (!entry.done) continue
      remove(entry)
      evicted.push(entry.id)
    }
    if (evicted.length) emit('evicted', evicted)
  }

  function evictForCount() {
    const evicted = []
    for (const entry of entries.values()) {
      if (entries.size <= limits.maxEntries) break
      if (!entry.done) continue
      remove(entry)
      evicted.push(entry.id)
    }
    if (evicted.length) emit('evicted', evicted)
  }

  function append(entry, body, chunk) {
    if (entry.removed || body.complete || !chunk?.length) return
    body.bytes += chunk.length
    if (body.truncated) return
    const wanted = Math.min(body.limit - body.retained, chunk.length)
    let granted = wanted
    if (wanted > 0) {
      if (usedBytes + wanted > limits.maxBytes) evictForBytes(wanted)
      granted = Math.max(0, Math.min(wanted, limits.maxBytes - usedBytes))
      if (granted > 0) {
        // Copy: tunnel chunks are views into whole WebSocket frames.
        const copy = Buffer.allocUnsafeSlow(granted)
        chunk.copy(copy, 0, 0, granted)
        body.chunks.push(copy)
        body.retained += granted
        usedBytes += granted
      }
    }
    if (granted < wanted) body.truncated = 'budget'
    else if (wanted < chunk.length) body.truncated = 'limit'
  }

  function compact(body) {
    if (body.chunks.length > 1) body.chunks = [Buffer.concat(body.chunks, body.retained)]
  }

  function exchange(entry) {
    const live = () => !entry.removed && !entry.done
    return {
      id: entry.id,
      requestChunk(chunk) {
        if (!live()) return
        append(entry, entry.request, chunk)
        emit('updated', entry)
      },
      requestEnd() {
        if (entry.removed || entry.request.complete) return
        entry.request.complete = true
        emit('updated', entry)
      },
      response(status, headers = {}, rawHeaders) {
        if (!live() || entry.status !== null) return
        entry.status = Number(status) || null
        entry.responseHeaders = { ...headers }
        entry.responseRawHeaders = Array.isArray(rawHeaders) ? rawHeaders.map(String) : null
        entry.responseAtMs = Math.round(performance.now() - entry.t0)
        emit('updated', entry)
      },
      responseChunk(chunk) {
        if (!live()) return
        append(entry, entry.response, chunk)
        emit('updated', entry)
      },
      /** WebSocket frame counters; `in` = visitor to app, `out` = app to visitor. */
      frame(direction, bytes) {
        if (!live() || !entry.websocket) return
        const ws = entry.websocket
        if (direction === 'in') { ws.framesIn++; ws.bytesIn += bytes || 0 }
        else { ws.framesOut++; ws.bytesOut += bytes || 0 }
        emit('updated', entry)
      },
      finish({ error, synthetic, responseTruncated, closeCode, closeReason } = {}) {
        if (!live()) return
        entry.done = true
        entry.durationMs = Math.round(performance.now() - entry.t0)
        if (error) entry.error = error instanceof Error ? error.message : String(error)
        if (synthetic) entry.synthetic = true
        if (!error) entry.response.complete = true
        // The gateway's end marker can trail the response; a body that matches its declared length is complete.
        if (!entry.request.complete && entry.declaredRequestBytes !== null && entry.request.bytes === entry.declaredRequestBytes) entry.request.complete = true
        if (responseTruncated && !entry.response.truncated) entry.response.truncated = 'tunnel'
        if (entry.websocket) {
          if (closeCode !== undefined) entry.websocket.closeCode = Number(closeCode) || null
          if (closeReason) entry.websocket.closeReason = String(closeReason)
        }
        compact(entry.request)
        compact(entry.response)
        emit('updated', entry)
        evictForCount()
      },
    }
  }

  return {
    limits: Object.freeze({ ...limits }),
    /** @returns {ReturnType<typeof exchange>} */
    begin(info = {}) {
      const kind = info.kind === 'websocket' ? 'websocket' : 'http'
      const entry = {
        id: nextId++,
        kind,
        source: info.source === 'replay' ? 'replay' : 'tunnel',
        replayOf: Number.isSafeInteger(info.replayOf) ? info.replayOf : null,
        /** A replay sent from the editor with a changed method, path, headers or body. */
        edited: info.source === 'replay' && Boolean(info.edited),
        replays: [],
        method: String(info.method ?? 'GET').toUpperCase(),
        path: String(info.path ?? '/'),
        headers: { ...(info.headers ?? {}) },
        publicUrl: info.publicUrl ? String(info.publicUrl) : null,
        protocolVersion: info.protocolVersion ?? null,
        declaredRequestBytes: Number.isSafeInteger(info.declaredRequestBytes) ? info.declaredRequestBytes : null,
        startedAt: Date.now(),
        t0: performance.now(),
        responseAtMs: null,
        durationMs: null,
        done: false,
        removed: false,
        status: null,
        responseHeaders: null,
        responseRawHeaders: null,
        error: null,
        synthetic: false,
        request: newBody(limits.requestBodyLimit),
        response: newBody(limits.responseBodyLimit),
        websocket: kind === 'websocket' ? { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, closeCode: null, closeReason: '' } : null,
      }
      entries.set(entry.id, entry)
      if (entry.replayOf !== null) {
        const original = entries.get(entry.replayOf)
        if (original) { original.replays.push(entry.id); emit('updated', original) }
      }
      emit('created', entry)
      evictForCount()
      return exchange(entry)
    },
    get(id) { return entries.get(Number(id)) ?? null },
    /** Entries with id > after, oldest first. */
    list({ after = 0, limit = Infinity } = {}) {
      const result = []
      for (const entry of entries.values()) {
        if (entry.id <= after) continue
        result.push(entry)
        if (result.length >= limit) break
      }
      return result
    },
    /** Retained bytes of a body as one Buffer. */
    body(entry, side) {
      const body = side === 'response' ? entry.response : entry.request
      return body.chunks.length === 1 ? body.chunks[0] : Buffer.concat(body.chunks, body.retained)
    },
    summary,
    clear() {
      for (const entry of [...entries.values()]) remove(entry)
      usedBytes = 0
      emit('cleared')
    },
    stats() {
      return { entries: entries.size, bytes: usedBytes, ...limits }
    },
    on(name, listener) { events.on(name, listener); return this },
    off(name, listener) { events.off(name, listener); return this },
  }
}

/** JSON-safe summary of an entry for lists and SSE. */
export function summary(entry) {
  const header = name => {
    const value = entry.responseHeaders?.[name]
    return Array.isArray(value) ? value.join(', ') : value ?? null
  }
  return {
    id: entry.id,
    kind: entry.kind,
    source: entry.source,
    replayOf: entry.replayOf,
    edited: entry.edited,
    replays: [...entry.replays],
    method: entry.method,
    path: entry.path,
    status: entry.status,
    startedAt: entry.startedAt,
    responseAtMs: entry.responseAtMs,
    durationMs: entry.durationMs,
    done: entry.done,
    error: entry.error,
    synthetic: entry.synthetic,
    publicUrl: entry.publicUrl,
    protocolVersion: entry.protocolVersion,
    contentType: header('content-type'),
    request: bodySummary(entry.request),
    response: bodySummary(entry.response),
    websocket: entry.websocket ? { ...entry.websocket } : null,
  }
}

function bodySummary(body) {
  return { bytes: body.bytes, retained: body.retained, truncated: body.truncated, complete: body.complete }
}

/**
 * Request body size implied by the visitor's framing headers: Content-Length, 0 when neither
 * Content-Length nor Transfer-Encoding is present, or null when chunked (end must be observed).
 */
export function declaredBodyBytes(headers = {}) {
  let length = null
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (key === 'transfer-encoding') return null
    if (key === 'content-length') length = /^\d+$/.test(String(value).trim()) ? Number(value) : NaN
  }
  if (length === null) return 0
  return Number.isSafeInteger(length) ? length : null
}

/**
 * Begin a capture without ever letting the inspector break the tunnel: returns a no-op
 * exchange when there is no store, and swallows any error thrown by the store or listeners.
 */
export function beginExchange(store, info) {
  if (!store) return NOOP_EXCHANGE
  let exchange
  try { exchange = store.begin(info) } catch { return NOOP_EXCHANGE }
  if (!exchange) return NOOP_EXCHANGE
  const safe = { id: exchange.id ?? null }
  for (const name of Object.keys(NOOP_EXCHANGE)) {
    if (name === 'id') continue
    safe[name] = (...args) => { try { exchange[name]?.(...args) } catch {} }
  }
  return safe
}
