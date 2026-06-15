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
| `--subdomain <name>` | Request a specific subdomain |
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
