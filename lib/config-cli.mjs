import {
  clearStoredToken,
  defaultConfigPath,
  readUserConfig,
  saveToken,
} from './user-config.mjs'
import { fail } from './config.mjs'

export function printConfigHelp() {
  console.log(`PortPreview config — save your CLI token locally

Usage:
  portpreview config set-token <token>   Save token to the local config file
  portpreview config check               Show config file location and token status
  portpreview config unset-token         Remove the saved token
  portpreview config --help              Show this help

After set-token, run tunnels without --token or export:
  portpreview 3000
  portpreview 3000 --subdomain my-app

Environment:
  PORTPREVIEW_CONFIG   Override config file path
`)
}

/**
 * @param {string[]} args
 */
export function runConfigCommand(args) {
  const subcommand = args[0]

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printConfigHelp()
    return
  }

  if (subcommand === 'set-token') {
    const token = args[1]
    if (!token) fail('Usage: portpreview config set-token <token>')
    saveToken(token)
    console.log(`Token saved to ${defaultConfigPath()}`)
    return
  }

  if (subcommand === 'check') {
    const configPath = defaultConfigPath()
    const config = readUserConfig()
    console.log(`Config file: ${configPath}`)
    console.log(`Token: ${config.token ? 'saved' : 'not set'}`)
    return
  }

  if (subcommand === 'unset-token') {
    const removed = clearStoredToken()
    console.log(
      removed
        ? `Token removed from ${defaultConfigPath()}`
        : `No config file at ${defaultConfigPath()}`,
    )
    return
  }

  fail(`Unknown config command: ${subcommand}`)
}
