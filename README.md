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

## Tunnel sessions and request history

Free accounts and anonymous visitors can run one active tunnel at a time. Free
sessions end after two hours; Pro sessions end after five hours. Run the command
again to start another session. Ultra and Team sessions have no time limit.
There is no automatic reconnect after a session expires.

HTTP and WebSocket traffic (including Vite/Next.js hot reload) use the same
protocol v2 tunnel. Gateway and CLI must both be updated together. The existing
1 MiB wire body limit remains; request history captures up to 64 KiB per request
and response body, with truncation clearly flagged. Requests made by automated
agents and webhooks are included.

Protect reserved preview domains with a password or IP/CIDR allowlist in the
dashboard (Pro and above). A password uses HTTP Basic authentication; enter any
username and your preview password. This credential is consumed by the gateway
and is not forwarded to localhost. Application HTTP Basic authentication cannot
share the same Authorization header, so use an application session cookie or a
bearer token route without preview password protection. Policy changes and token
revocations take effect within 30 seconds on connected gateways.
