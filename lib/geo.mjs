/** @type {Map<string, string | null>} */
const countryCache = new Map()

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

/**
 * @param {string} code
 * @returns {string | null}
 */
export function countryNameFromCode(code) {
  if (!code) return null
  const normalized = String(code).trim().toUpperCase()
  if (normalized.length !== 2 || normalized === 'XX') return null
  try {
    return regionNames.of(normalized) ?? null
  } catch {
    return null
  }
}

/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizeCountryName(value) {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  if (trimmed.length === 2) return countryNameFromCode(trimmed)
  return trimmed
}

/**
 * @param {string} ip
 */
export function isPublicIp(ip) {
  if (!ip || ip === 'unknown') return false
  if (ip.includes(':')) {
    if (ip === '::1') return false
    if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return false
    return true
  }

  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 10) return false
  if (a === 127) return false
  if (a === 0) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  return true
}

/**
 * @param {string} ip
 * @returns {Promise<string | null>}
 */
export async function resolveCountryFromIp(ip) {
  if (!isPublicIp(ip)) return null
  if (countryCache.has(ip)) return countryCache.get(ip) ?? null

  /** @type {string | null} */
  let country = null

  try {
    const response = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`,
      { signal: AbortSignal.timeout(3000) },
    )
    if (response.ok) {
      const data = await response.json()
      if (data?.status === 'success') {
        country = normalizeCountryName(data.country) ?? normalizeCountryName(data.countryCode)
      }
    }
  } catch {
    // Best-effort lookup — tunnel notifications still work without country.
  }

  countryCache.set(ip, country)
  return country
}
