import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN_PREFIX = 'pp_live_'

/**
 * @returns {string}
 */
export function defaultConfigPath() {
  if (process.env.PORTPREVIEW_CONFIG?.trim()) {
    return process.env.PORTPREVIEW_CONFIG.trim()
  }

  const home = os.homedir()

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return path.join(localAppData, 'portpreview', 'config.json')
  }

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'portpreview', 'config.json')
  }

  return path.join(home, '.config', 'portpreview', 'config.json')
}

/**
 * @param {string} token
 */
export function assertValidToken(token) {
  const value = token.trim()
  if (!value.startsWith(TOKEN_PREFIX) || value.length < 40 || value.length > 100) {
    throw new Error('Invalid token. Copy the CLI token from your PortPreview dashboard.')
  }
}

/**
 * @returns {{ token?: string }}
 */
export function readUserConfig() {
  const configPath = defaultConfigPath()
  if (!existsSync(configPath)) return {}

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof parsed?.token !== 'string') return {}
    const token = parsed.token.trim()
    return token ? { token } : {}
  } catch {
    return {}
  }
}

/**
 * @returns {string | undefined}
 */
export function readStoredToken() {
  return readUserConfig().token
}

/**
 * @param {string} token
 */
export function saveToken(token) {
  assertValidToken(token)
  const configPath = defaultConfigPath()
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })

  const payload = `${JSON.stringify({ token: token.trim() }, null, 2)}\n`
  writeFileSync(configPath, payload, { encoding: 'utf8', mode: 0o600 })
  chmodSync(configPath, 0o600)
}

export function clearStoredToken() {
  const configPath = defaultConfigPath()
  if (!existsSync(configPath)) return false
  unlinkSync(configPath)
  return true
}
