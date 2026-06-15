/** JSON wire format between the CLI client and the gateway. */

export const PROTOCOL_VERSION = 1

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} message
 */
export function send(ws, message) {
  ws.send(JSON.stringify(message))
}

/**
 * @param {string | Buffer | ArrayBuffer} data
 * @returns {Record<string, unknown>}
 */
export function parseMessage(data) {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
  const parsed = JSON.parse(text)
  if (!isObject(parsed)) throw new Error('Invalid message payload')
  return parsed
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
