import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { parseArgs } from '../lib/config.mjs'
import { runConfigCommand } from '../lib/config-cli.mjs'
import {
  clearStoredToken,
  defaultConfigPath,
  readStoredToken,
  saveToken,
} from '../lib/user-config.mjs'

const TEST_TOKEN = 'pp_live_' + 'a'.repeat(32)

describe('user config', () => {
  /** @type {string | undefined} */
  let tempDir
  /** @type {string | undefined} */
  let previousConfigEnv

  afterEach(() => {
    if (previousConfigEnv === undefined) {
      delete process.env.PORTPREVIEW_CONFIG
    } else {
      process.env.PORTPREVIEW_CONFIG = previousConfigEnv
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function useTempConfig() {
    previousConfigEnv = process.env.PORTPREVIEW_CONFIG
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'portpreview-config-'))
    process.env.PORTPREVIEW_CONFIG = path.join(tempDir, 'config.json')
  }

  it('saves and reads a token from the config file', () => {
    useTempConfig()
    saveToken(TEST_TOKEN)
    assert.equal(readStoredToken(), TEST_TOKEN)

    const raw = JSON.parse(readFileSync(defaultConfigPath(), 'utf8'))
    assert.equal(raw.token, TEST_TOKEN)
  })

  it('rejects invalid tokens', () => {
    useTempConfig()
    assert.throws(() => saveToken('bad-token'), /Invalid token/)
  })

  it('clears a saved token', () => {
    useTempConfig()
    saveToken(TEST_TOKEN)
    assert.equal(clearStoredToken(), true)
    assert.equal(readStoredToken(), undefined)
    assert.equal(clearStoredToken(), false)
  })

  it('parseArgs uses a stored token for reserved subdomains', () => {
    useTempConfig()
    saveToken(TEST_TOKEN)
    const opts = parseArgs(['3000', '--subdomain', 'my-app'])
    assert.equal(opts.subdomain, 'my-app')
    assert.equal(opts.apiToken, TEST_TOKEN)
  })

  it('prefers PORTPREVIEW_TOKEN over stored config', () => {
    useTempConfig()
    saveToken(TEST_TOKEN)
    const envToken = 'pp_live_' + 'b'.repeat(32)
    process.env.PORTPREVIEW_TOKEN = envToken
    const opts = parseArgs(['3000', '--subdomain', 'my-app'])
    assert.equal(opts.apiToken, envToken)
    delete process.env.PORTPREVIEW_TOKEN
  })
})

describe('config command', () => {
  /** @type {string | undefined} */
  let tempDir
  /** @type {string | undefined} */
  let previousConfigEnv

  afterEach(() => {
    if (previousConfigEnv === undefined) {
      delete process.env.PORTPREVIEW_CONFIG
    } else {
      process.env.PORTPREVIEW_CONFIG = previousConfigEnv
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function useTempConfig() {
    previousConfigEnv = process.env.PORTPREVIEW_CONFIG
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'portpreview-config-'))
    process.env.PORTPREVIEW_CONFIG = path.join(tempDir, 'config.json')
  }

  it('set-token writes the config file', () => {
    useTempConfig()
    runConfigCommand(['set-token', TEST_TOKEN])
    assert.equal(readStoredToken(), TEST_TOKEN)
  })

  it('unset-token removes the config file', () => {
    useTempConfig()
    runConfigCommand(['set-token', TEST_TOKEN])
    runConfigCommand(['unset-token'])
    assert.equal(readStoredToken(), undefined)
  })
})
