import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parseArgs } from '../lib/config.mjs'
import {
  clipBody,
  encodeFrame,
  MAX_BODY_BYTES,
  parseMessage,
  PROTOCOL_VERSION,
  publicUrl,
} from '../lib/protocol.mjs'
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
    const previousToken = process.env.PORTPREVIEW_TOKEN
    const previousConfig = process.env.PORTPREVIEW_CONFIG
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portpreview-config-'))
    delete process.env.PORTPREVIEW_TOKEN
    process.env.PORTPREVIEW_CONFIG = path.join(tempDir, 'config.json')
    try {
      assert.throws(
        () => parseArgs(['3000', '--subdomain', 'my-app']),
        /Reserved subdomains require/,
      )
      const opts = parseArgs(['3000', '--subdomain', 'my-app', '--token', 'pp_live_test'])
      assert.equal(opts.subdomain, 'my-app')
      assert.equal(opts.apiToken, 'pp_live_test')
    } finally {
      if (previousToken === undefined) delete process.env.PORTPREVIEW_TOKEN
      else process.env.PORTPREVIEW_TOKEN = previousToken
      if (previousConfig === undefined) delete process.env.PORTPREVIEW_CONFIG
      else process.env.PORTPREVIEW_CONFIG = previousConfig
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('protocol', () => {
  it('builds public https url', () => {
    assert.equal(publicUrl('jjm5s', 'portpreview.dev'), 'https://jjm5s.portpreview.dev')
  })

  it('attaches a raw body instead of base64 json', () => {
    const body = Buffer.from('hello from localhost')
    const frame = encodeFrame(
      { type: 'response', id: 'abc', status: 200, headers: { 'content-type': 'text/plain' } },
      body,
    )
    assert.equal(frame[0], 0)
    assert.equal(frame.toString('utf8').includes(body.toString('base64')), false)

    const parsed = parseMessage(frame)
    assert.equal(parsed.type, 'response')
    assert.deepEqual(parsed.body, body)
    assert.equal(String(parsed.headers?.['content-length']), String(body.length))
  })

  it('clips bodies over 1MB', () => {
    const clipped = clipBody(Buffer.alloc(MAX_BODY_BYTES + 50, 7))
    assert.equal(clipped.truncated, true)
    assert.equal(clipped.body.length, MAX_BODY_BYTES)

    const parsed = parseMessage(
      encodeFrame({ type: 'response', id: 'big', status: 200, headers: {} }, Buffer.alloc(MAX_BODY_BYTES + 50, 7)),
    )
    assert.equal(parsed.truncated, true)
    assert.equal(parsed.body.length, MAX_BODY_BYTES)
    assert.equal(String(parsed.headers?.['x-portpreview-truncated']), '1')
  })

  it('rejects legacy json text frames', () => {
    assert.throws(() => parseMessage(JSON.stringify({ type: 'register', version: PROTOCOL_VERSION })), /Invalid message/)
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
    localServer = http.createServer((req, res) => {
      if (req.url === '/large') {
        const payload = Buffer.alloc(MAX_BODY_BYTES + 128 * 1024, 0x61)
        res.writeHead(200, {
          'content-type': 'application/javascript',
          'content-length': String(payload.length),
        })
        res.end(payload)
        return
      }
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

  it('truncates responses over 1MB and keeps the tunnel open', async () => {
    const tunnel = await openTunnel({
      port: localPort,
      host: '127.0.0.1',
      gatewayUrl: gatewayInfo.wsUrl,
      tunnelDomain: `localhost:${GATEWAY_PORT}`,
      quiet: true,
    })

    const host = new URL(tunnel.url).host
    const response = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: GATEWAY_PORT,
            path: '/large',
            headers: { host },
          },
          resolve,
        )
        .on('error', reject)
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['x-portpreview-truncated'], '1')
    const body = await new Promise((resolve, reject) => {
      const chunks = []
      response.on('data', (c) => chunks.push(c))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    assert.equal(body.length, MAX_BODY_BYTES)

    const stillOpen = await new Promise((resolve, reject) => {
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
    assert.equal(stillOpen.statusCode, 200)
    stillOpen.resume()
    await new Promise((resolve) => stillOpen.on('end', resolve))
    await tunnel.close()
  })
})
