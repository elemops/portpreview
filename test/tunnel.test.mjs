import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { parseArgs } from '../lib/config.mjs'
import { publicUrl } from '../lib/protocol.mjs'
import { openTunnel } from '../lib/tunnel-client.mjs'
import { createGatewayServer } from './fixtures/gateway-server.mjs'

const GATEWAY_PORT = 14040

describe('config', () => {
  it('parses port and options', () => {
    const opts = parseArgs(['3000', '--host', '0.0.0.0', '--quiet'])
    assert.equal(opts.port, 3000)
    assert.equal(opts.host, '0.0.0.0')
    assert.equal(opts.quiet, true)
  })

  it('rejects invalid port', () => {
    assert.throws(() => parseArgs(['99999']), /Invalid port/)
  })

  it('requires a token for a reserved subdomain', () => {
    assert.throws(
      () => parseArgs(['3000', '--subdomain', 'my-app']),
      /Reserved subdomains require/,
    )
    const opts = parseArgs(['3000', '--subdomain', 'my-app', '--token', 'pp_live_test'])
    assert.equal(opts.subdomain, 'my-app')
    assert.equal(opts.apiToken, 'pp_live_test')
  })
})

describe('protocol', () => {
  it('builds public https url', () => {
    assert.equal(publicUrl('jjm5s', 'portpreview.dev'), 'https://jjm5s.portpreview.dev')
  })
})

describe('tunnel integration', () => {
  /** @type {import('node:http').Server} */
  let localServer
  /** @type {ReturnType<typeof createGatewayServer>} */
  let gateway
  let localPort
  /** @type {{ httpUrl: string, wsUrl: string }} */
  let gatewayInfo

  before(async () => {
    localServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello from localhost')
    })

    await new Promise((resolve) => {
      localServer.listen(0, '127.0.0.1', resolve)
    })
    localPort = /** @type {import('node:net').AddressInfo} */ (localServer.address()).port

    gateway = createGatewayServer({
      port: GATEWAY_PORT,
      host: '127.0.0.1',
      domain: `localhost:${GATEWAY_PORT}`,
    })
    gatewayInfo = await gateway.start()
  })

  after(async () => {
    await gateway.close()
    await new Promise((resolve) => localServer.close(resolve))
  })

  it('forwards HTTP through the tunnel', async () => {
    const tunnel = await openTunnel({
      port: localPort,
      host: '127.0.0.1',
      gatewayUrl: gatewayInfo.wsUrl,
      tunnelDomain: `localhost:${GATEWAY_PORT}`,
      quiet: true,
    })

    assert.match(tunnel.url, /^http:\/\/[a-z0-9]+\.localhost:14040$/)

    const host = new URL(tunnel.url).host
    const response = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: GATEWAY_PORT,
            path: '/',
            headers: { host },
          },
          resolve,
        )
        .on('error', reject)
    })

    assert.equal(response.statusCode, 200)
    const body = await new Promise((resolve, reject) => {
      const chunks = []
      response.on('data', (c) => chunks.push(c))
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', reject)
    })

    assert.equal(body, 'hello from localhost')
    await tunnel.close()
  })
})
