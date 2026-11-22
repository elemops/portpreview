import { startInspector } from './inspector-server.mjs'
import { createShareSecret, startShareServer } from './share-server.mjs'
import { openTunnel } from './tunnel-client.mjs'

/** `portpreview share <path>`: a read-only file server on 127.0.0.1 behind an ordinary HTTP tunnel. */
export async function runShare(parsed, { version }) {
  const expiresAt = parsed.expiresInMs ? Date.now() + parsed.expiresInMs : null
  const share = await startShareServer({
    root: parsed.sharePath,
    secret: createShareSecret(),
    password: parsed.password,
    includeHidden: parsed.includeHidden,
    expiresAt,
  })
  const options = { ...parsed, kind: 'http', host: share.host, port: share.port }
  if (!parsed.quiet) {
    console.log(`Sharing ${share.isFile ? 'file' : 'folder'} ${share.root} (read-only)`)
    console.log('Connecting to gateway…')
  }
  const controller = new AbortController()
  let tunnel, timer
  const inspector = parsed.inspect ? startInspector(options, { version, getTunnel: () => tunnel }) : null
  const cleanup = () => {
    clearTimeout(timer)
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown)
    void share.close(); void inspector?.close()
  }
  const shutdown = () => { controller.abort(); void tunnel?.close(); cleanup() }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  try {
    tunnel = await openTunnel({
      ...options,
      inspector: inspector?.store,
      signal: controller.signal,
      onReconnect: ({ url }) => console.log(parsed.quiet ? `${url}${share.path}` : `Reconnected. URL: ${url}${share.path}`),
    })
  } catch (error) {
    cleanup()
    if (controller.signal.aborted) return
    throw error
  }
  const url = `${tunnel.url}${share.path}`
  if (!parsed.quiet) {
    console.log('Connected')
    console.log(`URL:    ${url}`)
    const inspectUrl = await inspector?.url
    if (inspectUrl) console.log(`Inspect: ${inspectUrl}`)
    console.log(`Access: anyone with this link${parsed.password ? ' and the password' : ''} can view and download`)
    if (expiresAt) console.log(`Expires: ${new Date(expiresAt).toLocaleString()}`)
    if (!share.isFile && !parsed.includeHidden) console.log('Hidden: dot-files (.env, .git …) and private keys are not shared (--include-hidden to share them)')
    console.log('Press Ctrl+C to stop sharing.')
  } else {
    console.log(url)
    const inspectUrl = await inspector?.url
    if (inspectUrl) console.error(`Inspect: ${inspectUrl}`)
  }
  if (expiresAt) {
    timer = setTimeout(() => {
      if (!parsed.quiet) console.log('Share expired. Stopped sharing.')
      shutdown()
    }, Math.max(0, expiresAt - Date.now()))
  }
  void tunnel.closed.then(cleanup)
}
