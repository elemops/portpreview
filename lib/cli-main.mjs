import { parseArgs, printHelp } from './config.mjs'
import { runConfigCommand } from './config-cli.mjs'
import { openTunnel } from './tunnel-client.mjs'
import { startInspector } from './inspector-server.mjs'
import { runShare } from './share-cli.mjs'

/** Shared entry point for the npm command and the standalone executable. */
export async function runCli(argv, { version }) {
  if (argv[0] === 'config') {
    runConfigCommand(argv.slice(1))
    return
  }
  const parsed = parseArgs(argv)
  if ('help' in parsed) { printHelp(); return }
  if ('version' in parsed) { console.log(version); return }
  if (parsed.kind === 'share') { await runShare(parsed, { version }); return }

  const target = `${parsed.kind === 'tcp' ? '' : 'http://'}${parsed.host}:${parsed.port}`
  if (!parsed.quiet) {
    console.log('Connecting to gateway…')
    console.log(`Forwarding ${target}`)
  }
  const controller = new AbortController()
  let tunnel
  const inspector = parsed.inspect ? startInspector(parsed, { version, getTunnel: () => tunnel }) : null
  const shutdown = () => { controller.abort(); void tunnel?.close(); void inspector?.close() }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  try { tunnel = await openTunnel({ ...parsed, inspector: inspector?.store, signal: controller.signal }) }
  catch (error) {
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown)
    void inspector?.close()
    if (controller.signal.aborted) return
    throw error
  }
  if (!parsed.quiet) {
    console.log('Connected')
    console.log(`URL:    ${tunnel.url}`)
    const inspectUrl = await inspector?.url
    if (inspectUrl) console.log(`Inspect: ${inspectUrl}`)
    console.log(`Target: ${target}`)
    console.log('Press Ctrl+C to stop.')
  } else {
    console.log(tunnel.url)
    const inspectUrl = await inspector?.url
    if (inspectUrl) console.error(`Inspect: ${inspectUrl}`)
  }
  void tunnel.closed.then(() => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); void inspector?.close() })
}
