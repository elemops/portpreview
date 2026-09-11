import { scrypt, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { promisify } from 'node:util'

const deriveKey = promisify(scrypt)

export function clientIp(req, trustProxy = false) {
  const direct = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  // Only the locally bound, trusted reverse proxy may supply visitor identity.
  const forwarded = trustProxy && (direct === '127.0.0.1' || direct === '::1')
    ? String(req.headers['x-portpreview-client-ip'] ?? '').trim() : ''
  return isIP(forwarded) ? forwarded : direct
}

export function isIpAllowed(ip, rules = []) {
  if (!rules.length) return true
  const address = String(ip).replace(/^::ffff:/, '')
  if (!isIP(address)) return false
  return rules.some((rule) => {
    const [network, prefix] = String(rule).split('/')
    const family = isIP(network)
    if (!family || family !== isIP(address)) return false
    try {
      const list = new BlockList()
      const type = family === 6 ? 'ipv6' : 'ipv4'
      if (prefix === undefined) list.addAddress(network, type)
      else if (/^\d+$/.test(prefix)) list.addSubnet(network, Number(prefix), type)
      else return false
      return list.check(address, type)
    } catch { return false }
  })
}

export async function previewAccess(req, policy = {}, trustProxy = false) {
  if (!isIpAllowed(clientIp(req, trustProxy), policy.allowedIps)) return 403
  if (!policy.passwordHash) return 200
  const encoded = String(policy.passwordHash).split(':')
  if (encoded.length !== 3 || encoded[0] !== 'scrypt' || !/^[a-f0-9]{32}$/.test(encoded[1]) || !/^[a-f0-9]{128}$/.test(encoded[2])) return 403
  const authorization = String(req.headers.authorization ?? '')
  if (!authorization.startsWith('Basic ') || authorization.length > 4096) return 401
  const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
  const separator = credentials.indexOf(':')
  if (separator < 0) return 401
  const key = await deriveKey(credentials.slice(separator + 1), encoded[1], 64)
  if (!timingSafeEqual(key, Buffer.from(encoded[2], 'hex'))) return 401
  delete req.headers.authorization
  return 200
}
