#!/usr/bin/env node

import { createRequire } from 'node:module'
import { runCli } from '../lib/cli-main.mjs'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

runCli(process.argv.slice(2), { version }).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
