/** Wire format shared by CLI client and gateway. */

export const PROTOCOL_VERSION = 2

/** Hard cap for attached HTTP / WebSocket payloads. Oversized bodies are truncated. */
export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_HEADER_BYTES = 256 * 1024
export const MAX_FRAME_BYTES = 4 + MAX_HEADER_BYTES + MAX_BODY_BYTES

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} data
 * @returns {Buffer}
 */
export function toBuffer(data) {
  if (data == null) return Buffer.alloc(0)
  if (Buffer.isBuffer(data)) return data
  if (typeof data === 'string') return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => toBuffer(part)))
  return Buffer.from(data)
}

/**
 * @param {unknown} value
 * @param {number} [maxBytes]
 */
export function clipBody(value, maxBytes = MAX_BODY_BYTES) {
  const body = toBuffer(value)
  if (body.length <= maxBytes) {
    return { body, truncated: false, originalLength: body.length }
  }
  return {
    body: body.subarray(0, maxBytes),
    truncated: true,
    originalLength: body.length,
  }
}

/**
 * @param {Record<string, unknown>} header
 * @returns {Record<string, unknown>}
 */
function stripAttachedFields(header) {
  const { body: _body, data: _data, ...rest } = header
  return rest
}

/**
 * @param {Record<string, unknown>} headers
 * @param {number} length
 * @param {boolean} truncated
 * @returns {Record<string, unknown>}
 */
function withBodyHeaders(headers, length, truncated) {
  /** @type {Record<string, unknown>} */
  const next = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (name === 'content-length' || name === 'transfer-encoding') continue
    next[key] = value
  }
  next['content-length'] = String(length)
  if (truncated) next['x-portpreview-truncated'] = '1'
  return next
}

/**
 * Length-prefixed binary frame: [uint32be jsonLen][utf8 json][raw body].
 * JSON holds control fields only; the body is never base64.
 *
 * @param {Record<string, unknown>} header
 * @param {unknown} [body]
 */
export function encodeFrame(header, body) {
  const clipped = clipBody(body)
  const payload = stripAttachedFields(header)
  const truncated = Boolean(payload.truncated) || clipped.truncated
  if (truncated) {
    payload.truncated = true
    payload.originalLength = Number(payload.originalLength ?? clipped.originalLength)
  }

  if (
    (payload.type === 'request' || payload.type === 'response') &&
    isObject(payload.headers)
  ) {
    payload.headers = withBodyHeaders(
      /** @type {Record<string, unknown>} */ (payload.headers),
      clipped.body.length,
      truncated,
    )
  }

  const headerBuf = Buffer.from(JSON.stringify(payload), 'utf8')
  if (headerBuf.length > MAX_HEADER_BYTES) {
    throw new Error('Control header too large')
  }

  const frame = Buffer.allocUnsafe(4 + headerBuf.length + clipped.body.length)
  frame.writeUInt32BE(headerBuf.length, 0)
  headerBuf.copy(frame, 4)
  clipped.body.copy(frame, 4 + headerBuf.length)
  return frame
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} header
 * @param {unknown} [body]
 */
export function send(ws, header, body) {
  ws.send(encodeFrame(header, body), { binary: true })
}

/**
 * @param {unknown} data
 * @returns {Record<string, unknown> & { body: Buffer }}
 */
export function parseMessage(data) {
  const buf = toBuffer(data)
  if (buf.length < 4 || buf[0] === 0x7b) {
    throw new Error('Invalid message payload')
  }

  const headerLen = buf.readUInt32BE(0)
  if (headerLen < 2 || headerLen > MAX_HEADER_BYTES || 4 + headerLen > buf.length) {
    throw new Error('Invalid message header')
  }

  const parsed = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'))
  if (!isObject(parsed)) throw new Error('Invalid message payload')
  parsed.body = buf.subarray(4 + headerLen)
  return /** @type {Record<string, unknown> & { body: Buffer }} */ (parsed)
}

/**
 * @param {Record<string, unknown>} message
 */
export function attachedBody(message) {
  return Buffer.isBuffer(message.body) ? message.body : Buffer.alloc(0)
}

/**
 * @param {string} subdomain
 * @param {string} tunnelDomain
 */
export function publicUrl(subdomain, tunnelDomain) {
  return `https://${subdomain}.${tunnelDomain}`
}

/**
 * @param {string} subdomain
 * @param {string} tunnelDomain
 */
export function localGatewayHttpUrl(subdomain, tunnelDomain) {
  if (tunnelDomain.includes(':')) {
    return `http://${subdomain}.${tunnelDomain}`
  }
  return publicUrl(subdomain, tunnelDomain)
}
