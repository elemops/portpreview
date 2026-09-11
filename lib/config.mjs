/** @typedef {{ port: number, host: string, subdomain?: string, apiToken?: string, gatewayUrl: string, tunnelDomain: string, quiet: boolean }} TunnelOptions */

import { readStoredToken } from './user-config.mjs'

export const DEFAULT_TUNNEL_DOMAIN = 'portpreview.dev'
export const DEFAULT_GATEWAY_URL = 'wss://gateway.portpreview.dev/tunnel'

/**
 * @param {string[]=} argv
 * @returns {TunnelOptions | { help: true } | { version: true }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let port
  let host = '127.0.0.1'
  /** @type {string | undefined} */
  let subdomain
  let apiToken = process.env.PORTPREVIEW_TOKEN?.trim() || readStoredToken() || undefined
  let gatewayUrl = process.env.PORTPREVIEW_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL
  let tunnelDomain = process.env.PORTPREVIEW_TUNNEL_DOMAIN?.trim() || DEFAULT_TUNNEL_DOMAIN
  let quiet = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--version' || arg === '-v') return { version: true }
    if (arg === '--quiet' || arg === '-q') {
      quiet = true
      continue
    }
    if (arg === '--host') {
      host = argv[++i] ?? fail('--host requires a value')
      continue
    }
    if (arg === '--subdomain') {
      subdomain = argv[++i] ?? fail('--subdomain requires a value')
      continue
    }
    if (arg === '--token') {
      apiToken = argv[++i] ?? fail('--token requires a value')
      continue
    }
    if (arg === '--gateway') {
      gatewayUrl = argv[++i] ?? fail('--gateway requires a value')
      continue
    }
    if (arg === '--domain') {
      tunnelDomain = argv[++i] ?? fail('--domain requires a value')
      continue
    }
    if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
    if (port !== undefined) fail(`Unexpected argument: ${arg}`)
    port = Number(arg)
  }

  if (port === undefined) fail('Missing local port. Usage: portpreview <port>')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port: ${argv.find((a) => !a.startsWith('-'))}`)
  }

  if (subdomain && !apiToken) {
    fail('Reserved subdomains require --token, PORTPREVIEW_TOKEN, or portpreview config set-token')
  }

  return { port, host, subdomain, apiToken, gatewayUrl, tunnelDomain, quiet }
}

export function printHelp() {
  console.log(`PortPreview — expose localhost through a public URL

Usage:
  portpreview <port> [options]
  portpreview config <command>

Options:
  --host <addr>         Local bind address to forward to (default: 127.0.0.1)
  --subdomain <name>    Use a subdomain reserved by your account
  --token <token>       Authenticate with a CLI token
  --gateway <url>       WebSocket gateway URL (default: ${DEFAULT_GATEWAY_URL})
  --domain <domain>     Public tunnel domain (default: ${DEFAULT_TUNNEL_DOMAIN})
  -q, --quiet           Minimal output
  -h, --help            Show this help
  -v, --version         Show version

Config:
  portpreview config set-token <token>   Save token locally (recommended)
  portpreview config check               Show config file location
  portpreview config unset-token         Remove saved token

Environment:
  PORTPREVIEW_GATEWAY_URL   Override gateway WebSocket URL
  PORTPREVIEW_TUNNEL_DOMAIN Override public tunnel domain
  PORTPREVIEW_TOKEN         Authenticate with a CLI token
  PORTPREVIEW_CONFIG        Override config file path

Examples:
  portpreview config set-token pp_live_...
  portpreview 3000
  portpreview 8080 --subdomain myapp
  portpreview 3000 --gateway ws://127.0.0.1:4040/tunnel --domain localhost:4040
`)
}

/**
 * @param {string} message
 * @returns {never}
 */
export function fail(message) {
  throw new Error(message)
}
