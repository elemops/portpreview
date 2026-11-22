import { normalizeCountryName, resolveCountryFromIp } from './geo.mjs'

/**
 * @typedef {Object} TunnelSession
 * @property {string} subdomain
 * @property {string} url
 * @property {string} localHost
 * @property {number} localPort
 * @property {Date} openedAt
 * @property {Date} [closedAt]
 * @property {string} clientIp
 * @property {string | null} country
 * @property {Record<string, number>} [messageIds]
 */

/** @typedef {{ ip: string, country: string | null }} ClientInfo */

/**
 * @typedef {Object} SiteVisit
 * @property {string} path
 * @property {string | null} locale
 * @property {string | null} referer
 * @property {string} ip
 * @property {string | null} country
 * @property {string | null} userAgent
 * @property {Date} visitedAt
 */

/**
 * @param {import('node:http').IncomingMessage | import('node:http').IncomingMessage & { headers: Record<string, string | string[] | undefined> }} req
 * @param {{ path: string, locale?: string | null }} context
 * @returns {SiteVisit}
 */
export function extractSiteVisit(req, context) {
  const clientInfo = extractClientInfo(req)
  const referer = req.headers.referer ?? req.headers.referrer ?? null
  const userAgent = req.headers['user-agent'] ?? null

  return {
    path: context.path,
    locale: context.locale ?? null,
    referer: referer ? String(referer) : null,
    ip: clientInfo.ip,
    country: clientInfo.country,
    userAgent: userAgent ? String(userAgent) : null,
    visitedAt: new Date(),
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
export function extractClientInfo(req) {
  const forwarded =
    req.headers['cf-connecting-ip'] ??
    String(req.headers['x-forwarded-for'] ?? '')
      .split(',')[0]
      ?.trim() ??
    req.headers['x-real-ip'] ??
    req.socket?.remoteAddress

  const ip = forwarded ? String(forwarded).replace(/^::ffff:/, '') : 'unknown'
  const rawCountry = req.headers['cf-ipcountry']
  const country =
    rawCountry && String(rawCountry).toUpperCase() !== 'XX' ? String(rawCountry).toUpperCase() : null

  return { ip, country }
}

/**
 * Uses Cloudflare country when present; otherwise resolves from the client IP.
 * @param {ClientInfo} clientInfo
 * @returns {Promise<ClientInfo>}
 */
export async function enrichClientInfo(clientInfo) {
  let country = normalizeCountryName(clientInfo.country)

  if (!country && clientInfo.ip && clientInfo.ip !== 'unknown') {
    country = await resolveCountryFromIp(clientInfo.ip)
  }

  return country ? { ...clientInfo, country } : { ...clientInfo, country: null }
}
