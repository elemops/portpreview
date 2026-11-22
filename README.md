# PortPreview CLI

[![npm](https://img.shields.io/npm/v/portpreview)](https://www.npmjs.com/package/portpreview)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Open-source localhost tunnel client for [PortPreview](https://portpreview.com).
One command gives a local HTTP server a public HTTPS URL on `*.portpreview.dev`
for webhook debugging, OAuth callbacks, and client or mobile previews — without
deploying to staging.

```bash
npx portpreview 3000
```

```
URL:    https://jjm5s.portpreview.dev
Target: http://127.0.0.1:3000
```

No signup and no config file. Requires Node.js 18 or newer.

## What you get

- **Public HTTPS URL** that forwards to `http://127.0.0.1:<port>`; visitors see
  your app directly, with no warning or interstitial page.
- **Live request log** in the terminal: method, path, status, and response time
  of every request, e.g. `POST /webhooks/stripe 200 19ms`.
- **Local request inspector** at `http://127.0.0.1:4041` while the CLI runs: headers,
  bodies, copy as cURL, replay, and edit-and-replay against your app. No account;
  nothing leaves your machine.
- **Webhook-safe forwarding**: raw bodies and headers reach your app unchanged,
  so Stripe and GitHub signature checks pass. `Host` is rewritten to
  `127.0.0.1:<port>`, so Vite and similar dev servers need no `allowedHosts` change.
- **WebSocket, Server-Sent Events, and HMR** through the tunnel.
- **Streaming bodies** with no total size limit, and automatic reconnect with
  backoff after network loss.
- **No session time limit** on any plan.

With a free account you also get a reserved subdomain, request history in the web
dashboard, and password or IP allowlist protection for previews. Paid plans add raw
TCP tunnels: `npx portpreview tcp 5432` gives `tcp.portpreview.dev:<port>`. See
[pricing](https://portpreview.com/pricing).

## Usage

```bash
npx portpreview 3000                          # random subdomain
npx portpreview config set-token pp_live_...  # save a CLI token from the dashboard
npx portpreview 3000 --subdomain my-app       # reserved subdomain
npx portpreview tcp 5432                      # raw TCP tunnel (paid plans)
```

| Option | Description |
|---|---|
| `--host <addr>` | Local address to forward to (default `127.0.0.1`) |
| `--subdomain <name>` | Use a subdomain reserved by your account |
| `--token <token>` | Authenticate with a CLI token |
| `--gateway <url>` | Gateway WebSocket URL (default `wss://gateway.portpreview.dev/tunnel`) |
| `--domain <domain>` | Public tunnel domain (default `portpreview.dev`) |
| `--no-inspect` / `--inspect-port <n>` | Turn the local inspector off, or choose its port (default `4041`) |
| `-q, --quiet` | Print only the public URL |
| `-h, --help` / `-v, --version` | Help and version |

| Environment variable | Description |
|---|---|
| `PORTPREVIEW_TOKEN` | CLI token |
| `PORTPREVIEW_CONFIG` | Config file path (default `~/.config/portpreview/config.json` on Linux) |
| `PORTPREVIEW_GATEWAY_URL` | Gateway WebSocket URL |
| `PORTPREVIEW_TUNNEL_DOMAIN` | Public tunnel domain |

If your server listens only on IPv6 `::1` (default Vite), start it with
`--host 127.0.0.1` or pass `--host ::1` to the CLI.

## Limits

- HTTP and WebSocket on every plan; raw TCP on paid plans; no UDP.
- WebSocket messages up to 1 MiB each.
- Streams with no progress for 120 seconds are closed.
- One gateway region (Tokyo, Japan).
- The local inspector keeps the last 200 requests in memory; the dashboard stores
  the first 64 KiB of each body.
- A tunnel URL is not a secret: its TLS certificate is listed in public Certificate
  Transparency logs, so scanners usually find a new URL within minutes. Do not expose
  debug endpoints; protect reserved previews with a password or an IP allowlist.

Full reference: [portpreview.com/docs](https://portpreview.com/docs).

## What is open source

This repository contains the CLI client published to npm as
[`portpreview`](https://www.npmjs.com/package/portpreview). The hosted gateway,
dashboard, request history, and billing are not open source.

`npm test` here covers argument parsing, the wire protocol, the token store and a
tunnel against a small fixture gateway. The streaming, reconnect, inspector and TCP
suites need the hosted gateway code and run in the private repository before each
release.

## License

[Apache-2.0](LICENSE) © 2026 ElemOps
