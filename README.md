# PortPreview

Expose a local port through a public HTTPS URL.

```bash
npx portpreview 3000
```

Connects to the PortPreview gateway and forwards public traffic to `http://127.0.0.1:3000`.

## Install

```bash
npm install -g portpreview
portpreview 3000
```

Pin a version:

```bash
npx portpreview@0.1.0 3000
```

## Options

| Flag | Description |
|------|-------------|
| `--host <addr>` | Local address to forward to (default `127.0.0.1`) |
| `--subdomain <name>` | Use a subdomain reserved in your PortPreview account |
| `--token <token>` | Authenticate with a CLI token from the dashboard |
| `--gateway <url>` | WebSocket gateway URL |
| `--domain <domain>` | Public tunnel domain |
| `-q, --quiet` | Print only the public URL |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Environment

| Variable | Default |
|----------|---------|
| `PORTPREVIEW_GATEWAY_URL` | `wss://gateway.portpreview.dev/tunnel` |
| `PORTPREVIEW_TUNNEL_DOMAIN` | `portpreview.dev` |
| `PORTPREVIEW_TOKEN` | CLI token used for reserved subdomains |
| `PORTPREVIEW_CONFIG` | Override local config file path |

## Persistent token (recommended)

Save your CLI token once, like ngrok's `config add-authtoken`:

```bash
npx portpreview config set-token pp_live_...
npx portpreview 3000
```

Default config locations:

| OS | Path |
|----|------|
| Linux | `~/.config/portpreview/config.json` |
| macOS | `~/Library/Application Support/portpreview/config.json` |
| Windows | `%LOCALAPPDATA%\\portpreview\\config.json` |

Check where your config is stored:

```bash
npx portpreview config check
```

Remove the saved token:

```bash
npx portpreview config unset-token
```

## Reserved subdomains

Create a free account at [portpreview.com/register](https://portpreview.com/register), reserve a
subdomain in the dashboard, and save your default CLI token. Then either pass the token directly:

```bash
npx portpreview 3000 --subdomain my-project --token pp_live_...
```

Or save it once with config:

```bash
npx portpreview config set-token pp_live_...
npx portpreview 3000 --subdomain my-project
```

Or keep it in the current shell only:

```bash
export PORTPREVIEW_TOKEN=pp_live_...
npx portpreview 3000 --subdomain my-project
```

Commands without `--subdomain` continue to work anonymously with a random URL.

## Programmatic API

```javascript
import { openTunnel } from 'portpreview'

const tunnel = await openTunnel({ port: 3000, quiet: true })
console.log(tunnel.url)
await tunnel.close()
```

## Development

```bash
git clone https://github.com/elemops/portpreview.git
cd portpreview
npm install
npm test
node bin/portpreview.mjs 3000
```

## License

Apache-2.0
