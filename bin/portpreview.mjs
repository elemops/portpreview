#!/usr/bin/env node

import packageJson from '../package.json' with { type: 'json' }
import { parseArgs, printHelp } from '../lib/config.mjs'
import { openTunnel } from '../lib/tunnel-client.mjs'

async function main() {
  const parsed = parseArgs()

  if ('help' in parsed) {
    printHelp()
    return
  }

  if ('version' in parsed) {
    console.log(packageJson.version)
    return
  }

  const target = `http://${parsed.host}:${parsed.port}`

  if (!parsed.quiet) {
    console.log('Connecting to gateway…')
    console.log(`Forwarding ${target}`)
  }

  let tunnel
  try {
    tunnel = await openTunnel(parsed)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (!parsed.quiet) {
    console.log('Connected')
    console.log(`URL:    ${tunnel.url}`)
    console.log(`Target: ${target}`)
    console.log('Press Ctrl+C to stop.')
  } else {
    console.log(tunnel.url)
  }

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) {
      process.exit(1)
      return
    }
    shuttingDown = true

    tunnel
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
