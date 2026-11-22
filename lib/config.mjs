/** @typedef {{ kind: 'http' | 'tcp', port: number, host: string, subdomain?: string, apiToken?: string, gatewayUrl: string, tunnelDomain: string, quiet: boolean }} TunnelOptions */
/** @typedef {{ inspect: boolean, inspectPort: number, inspectPortExplicit: boolean }} InspectOptions */

import { readStoredToken } from './user-config.mjs'
import { DEFAULT_INSPECTOR_PORT as DEFAULT_INSPECT_PORT } from './inspector-store.mjs'

export const DEFAULT_TUNNEL_DOMAIN = 'portpreview.dev'
export const DEFAULT_GATEWAY_URL = 'wss://gateway.portpreview.dev/tunnel'

/**
 * @param {string[]=} argv
 * @returns {(TunnelOptions & InspectOptions) | { help: true } | { version: true }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let port
  /** @type {'http' | 'tcp'} */
  let kind = 'http'
  let host = '127.0.0.1'
  /** @type {string | undefined} */
  let subdomain
  let apiToken = process.env.PORTPREVIEW_TOKEN?.trim() || readStoredToken() || undefined
  let gatewayUrl = process.env.PORTPREVIEW_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL
  let tunnelDomain = process.env.PORTPREVIEW_TUNNEL_DOMAIN?.trim() || DEFAULT_TUNNEL_DOMAIN
  let quiet = false
  /** @type {boolean | undefined} undefined = default (on unless --quiet) */
  let inspect
  let inspectPort

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--version' || arg === '-v') return { version: true }
    if (arg === '--quiet' || arg === '-q') {
      quiet = true
      continue
    }
    if (arg === '--inspect' || arg === '--no-inspect') {
      inspect = arg === '--inspect'
      continue
    }
    if (arg === '--inspect-port') {
      inspectPort = parseInspectPort(argv[++i] ?? fail('--inspect-port requires a value'), '--inspect-port')
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
    if (arg === 'tcp' && kind === 'http' && port === undefined) {
      kind = 'tcp'
      continue
    }
    if (port !== undefined) fail(`Unexpected argument: ${arg}`)
    port = Number(arg)
  }

  if (port === undefined) fail(kind === 'tcp' ? 'Missing local port. Usage: portpreview tcp <port>' : 'Missing local port. Usage: portpreview <port>')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port: ${argv.find((a) => !a.startsWith('-') && a !== 'tcp')}`)
  }

  if (kind === 'tcp') {
    if (subdomain) fail('TCP tunnels do not use --subdomain: your account has one stable TCP port')
    if (!apiToken) fail('TCP tunnels require a paid plan and a CLI token. Run: portpreview config set-token <token>')
  }

  if (subdomain && !apiToken) {
    fail('Reserved subdomains require --token, PORTPREVIEW_TOKEN, or portpreview config set-token')
  }

  const inspector = inspectOptions(inspect, inspectPort, quiet)
  // The request inspector understands HTTP only.
  return { kind, port, host, subdomain, apiToken, gatewayUrl, tunnelDomain, quiet, ...inspector, ...(kind === 'tcp' ? { inspect: false } : {}) }
}

/** Flags win over PORTPREVIEW_INSPECT / PORTPREVIEW_INSPECT_PORT; the default is on unless --quiet. */
function inspectOptions(flag, flagPort, quiet) {
  const env = process.env.PORTPREVIEW_INSPECT?.trim().toLowerCase()
  let inspect = flag
  if (inspect === undefined && env) {
    if (['1', 'true', 'yes', 'on'].includes(env)) inspect = true
    else if (['0', 'false', 'no', 'off'].includes(env)) inspect = false
    else fail(`Invalid PORTPREVIEW_INSPECT: ${env} (use 1 or 0)`)
  }
  const envPort = process.env.PORTPREVIEW_INSPECT_PORT?.trim()
  const inspectPort = flagPort ?? (envPort ? parseInspectPort(envPort, 'PORTPREVIEW_INSPECT_PORT') : undefined)
  return { inspect: inspect ?? !quiet, inspectPort: inspectPort ?? DEFAULT_INSPECT_PORT, inspectPortExplicit: inspectPort !== undefined }
}

function parseInspectPort(value, name) {
  const port = Number(value)
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port > 65535) fail(`Invalid ${name}: ${value}`)
  return port
}

export function printHelp() {
  console.log(`PortPreview — expose localhost through a public URL

Usage:
  portpreview <port> [options]       HTTP tunnel with a public HTTPS URL
  portpreview tcp <port> [options]   Raw TCP tunnel (paid plans)
  portpreview config <command>

Options:
  --host <addr>         Local bind address to forward to (default: 127.0.0.1)
  --subdomain <name>    Use a subdomain reserved by your account
  --token <token>       Authenticate with a CLI token
  --gateway <url>       WebSocket gateway URL (default: ${DEFAULT_GATEWAY_URL})
  --domain <domain>     Public tunnel domain (default: ${DEFAULT_TUNNEL_DOMAIN})
  --inspect             Start the local request inspector (default: on, off with --quiet)
  --no-inspect          Do not start the request inspector
  --inspect-port <n>    Inspector port on 127.0.0.1 (default: ${DEFAULT_INSPECT_PORT}, next free port if busy)
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
  PORTPREVIEW_INSPECT       1 or 0 to turn the request inspector on or off
  PORTPREVIEW_INSPECT_PORT  Request inspector port (default: ${DEFAULT_INSPECT_PORT})

Examples:
  portpreview config set-token pp_live_...
  portpreview 3000
  portpreview 8080 --subdomain myapp
  portpreview tcp 5432
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
