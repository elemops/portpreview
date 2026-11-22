import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { formatBytes } from './tcp-client.mjs'

/**
 * Read-only file server behind `portpreview share <path>`. It listens on 127.0.0.1 only and
 * answers solely under /s/<secret>/, so a visitor who only knows the tunnel hostname (which
 * Certificate Transparency logs publish) gets 404 for everything. Dot-files and key material
 * stay invisible unless includeHidden is set, and nothing outside the shared root is served,
 * even through symlinks.
 */

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', apng: 'image/apng', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', weba: 'audio/webm',
  pdf: 'application/pdf', json: 'application/json; charset=utf-8', vtt: 'text/vtt; charset=utf-8',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', tar: 'application/x-tar',
}
// Shown as plain text: source code, configs and markup must never run in the visitor's browser.
const TEXT_EXTENSIONS = new Set(('txt md markdown log csv tsv xml yaml yml toml ini conf cfg properties sh bash zsh fish ps1 bat cmd '
  + 'py rb go rs java kt kts scala c h cpp hpp cc cs m swift js mjs cjs ts tsx jsx vue svelte css scss sass less sql php pl lua r '
  + 'dart ex exs erl hs clj gradle diff patch srt rst tex adoc graphql proto').split(' '))
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'changelog', 'makefile', 'dockerfile', 'procfile', 'notice', 'authors'])
// Already compressed: ZIP stores them (deflate level 0) instead of wasting CPU.
const COMPRESSED_EXTENSIONS = new Set(('png jpg jpeg gif webp avif heic mp4 m4v webm mov mkv mp3 m4a aac ogg oga opus flac '
  + 'zip gz tgz 7z rar xz bz2 zst docx xlsx pptx odt jar apk woff2 pdf').split(' '))
const SENSITIVE_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'kdbx', 'ppk', 'env', 'gpg', 'asc', 'tfstate', 'ovpn', 'keychain', 'keychain-db'])
const SENSITIVE_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?|key4\.db|logins\.json|cookies\.sqlite|wallet\.dat|.*\.tfstate\.backup)$/

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'cache-control': 'private, no-cache',
}

/** 128-bit random path segment: the share URL is the capability. */
export function createShareSecret() {
  return randomBytes(16).toString('base64url')
}

/** Dot-files (.env, .git, .ssh, .npmrc …) and private keys or credential stores. */
export function isHiddenName(name) {
  const lower = String(name).toLowerCase()
  if (lower.startsWith('.')) return true
  if (SENSITIVE_NAME.test(lower)) return true
  return SENSITIVE_EXTENSIONS.has(extension(lower))
}

export function contentTypeFor(name) {
  const ext = extension(name)
  if (MIME[ext]) return MIME[ext]
  if (TEXT_EXTENSIONS.has(ext) || (!ext && TEXT_NAMES.has(String(name).toLowerCase()))) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

/**
 * One `bytes=` range; multiple ranges are ignored (a full 200 is a valid answer).
 * @returns {null | 'unsatisfiable' | { start: number, end: number }}
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!match || (!match[1] && !match[2])) return null
  let start, end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (match[2] && Number(match[2]) < start) return null
  }
  if (start >= size || size === 0) return 'unsatisfiable'
  return { start, end }
}

/** `30m`, `1h`, `2d`, `90s`; a bare number means minutes. */
export function parseDuration(value) {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(value ?? '').trim())
  if (!match) return null
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match[2] ?? 'm').toLowerCase()]
  const ms = Number(match[1]) * unit
  return ms > 0 ? ms : null
}

/**
 * @param {{ root: string, secret?: string, password?: string, includeHidden?: boolean, expiresAt?: number | null }} options
 * @returns {Promise<{ host: string, port: number, path: string, name: string, root: string, isFile: boolean, close: () => Promise<void> }>}
 */
export async function startShareServer({ root, secret = createShareSecret(), password, includeHidden = false, expiresAt = null }) {
  const absolute = path.resolve(String(root))
  let realRoot, rootStat
  try {
    realRoot = await fsp.realpath(absolute)
    rootStat = await fsp.stat(realRoot)
  } catch (error) {
    throw new Error(error?.code === 'ENOENT' ? `Path not found: ${absolute}` : `Cannot read ${absolute}: ${error.message}`)
  }
  const isFile = rootStat.isFile()
  // A whole home folder or drive holds browser profiles, keychains and app tokens that no name filter catches.
  const home = await fsp.realpath(os.homedir()).catch(() => null)
  if (!isFile && (realRoot === home || path.dirname(realRoot) === realRoot)) {
    throw new Error(`Refusing to share ${realRoot === home ? 'your whole home folder' : 'a whole drive'} (${absolute}). Share a subfolder instead`)
  }
  if (!isFile && !rootStat.isDirectory()) throw new Error(`Not a file or folder: ${absolute}`)
  if (!isFile) await fsp.readdir(realRoot).catch(error => { throw new Error(`Cannot read ${absolute}: ${error.message}`) })
  const name = path.basename(realRoot) || realRoot
  const base = `/s/${secret}/`
  const passwordDigest = password ? sha256(password) : null
  const secretBytes = Buffer.from(secret)
  const sockets = new Set()

  /** Resolve URL segments to a real path inside the share, or null. */
  async function resolve(segments) {
    if (isFile) {
      if (!segments.length) return { virtual: true }
      return segments.length === 1 && segments[0] === name ? { file: realRoot, stat: await fsp.stat(realRoot) } : null
    }
    if (!includeHidden && segments.some(isHiddenName)) return null
    let real
    try { real = await fsp.realpath(path.join(realRoot, ...segments)) } catch { return null }
    if (!insideShare(real)) return null
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat) return null
    return stat.isDirectory() ? { dir: real, stat } : stat.isFile() ? { file: real, stat } : null
  }

  /** Inside the root and, after following symlinks, not a hidden file either. */
  function insideShare(real) {
    const relative = path.relative(realRoot, real)
    if (relative === '') return true
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
    return includeHidden || !relative.split(path.sep).some(isHiddenName)
  }

  async function listDirectory(dir) {
    if (dir === null) return [{ name, isDir: false, size: rootStat.size, mtime: rootStat.mtimeMs }]
    const items = []
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      // Names with `\` cannot be requested (see invalidSegment), so they are not listed either.
      if ((!includeHidden && isHiddenName(entry.name)) || entry.name.includes('\\')) continue
      const full = path.join(dir, entry.name)
      let stat
      if (entry.isSymbolicLink()) {
        const real = await fsp.realpath(full).catch(() => null)
        if (!real || !insideShare(real)) continue
        stat = await fsp.stat(real).catch(() => null)
      } else if (entry.isFile() || entry.isDirectory()) stat = await fsp.stat(full).catch(() => null)
      if (!stat || !(stat.isFile() || stat.isDirectory())) continue
      items.push({ name: entry.name, isDir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size, mtime: stat.mtimeMs })
    }
    return items
  }

  async function handle(req, res) {
    const [rawPath, query = ''] = String(req.url ?? '/').split('?', 2)
    const parts = rawPath.split('/')
    // parts: ['', 's', '<secret>', ...rest]
    if (parts[1] !== 's' || !sameSecret(parts[2])) return plain(res, 404, 'Not found')
    if (parts.length === 3) return redirect(res, `${base}${query ? `?${query}` : ''}`)
    if (expiresAt && Date.now() >= expiresAt) return plain(res, 410, 'This share has expired')
    if (passwordDigest && !passwordMatches(req.headers.authorization)) {
      res.writeHead(401, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="PortPreview share", charset="UTF-8"' })
      return res.end('Password required')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Read-only share')
    }
    const rest = parts.slice(3)
    const trailingSlash = rest[rest.length - 1] === ''
    if (trailingSlash) rest.pop()
    let segments
    try { segments = rest.map(decodeURIComponent) } catch { return plain(res, 400, 'Bad request') }
    if (segments.some(invalidSegment)) return plain(res, 404, 'Not found')
    const target = await resolve(segments)
    if (!target) return plain(res, 404, 'Not found')
    const params = new URLSearchParams(query)
    const urlPath = base + segments.map(encodeURIComponent).join('/')

    if (target.virtual || target.dir) {
      if (!trailingSlash && segments.length) return redirect(res, `${urlPath}/${query ? `?${query}` : ''}`)
      const dirName = segments.length ? segments[segments.length - 1] : name
      if (params.has('zip') && !isFile) return sendZip(req, res, target.dir, dirName)
      const items = await listDirectory(target.virtual ? null : target.dir)
      return sendListing(req, res, { name, segments, items, base, isFile, expiresAt })
    }
    if (trailingSlash) return plain(res, 404, 'Not found')
    return sendFile(req, res, target.file, target.stat, segments[segments.length - 1], params.has('download'))
  }

  async function sendZip(req, res, dir, dirName) {
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': 'application/zip',
      'content-disposition': disposition('attachment', `${dirName}.zip`),
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') return res.end()
    const zip = createZipWriter(res)
    // Folders on the current path: a symlink back to one of them would recurse forever.
    const ancestors = new Set()
    const walk = async (folder, prefix) => {
      ancestors.add(folder)
      const entries = (await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (res.destroyed) throw new Error('Client disconnected')
        if (!includeHidden && isHiddenName(entry.name)) continue
        // Windows extractors treat `\` as a separator: such a name could unpack outside the target folder.
        if (entry.name.includes('\\')) continue
        const full = path.join(folder, entry.name)
        const real = entry.isSymbolicLink() ? await fsp.realpath(full).catch(() => null) : full
        if (!real || (entry.isSymbolicLink() && !insideShare(real))) continue
        const stat = await fsp.stat(real).catch(() => null)
        if (!stat) continue
        if (stat.isDirectory()) {
          if (ancestors.has(real)) continue
          await zip.directory(`${prefix}${entry.name}/`, stat.mtime)
          await walk(real, `${prefix}${entry.name}/`)
        } else if (stat.isFile()) {
          await zip.file(`${prefix}${entry.name}`, real, stat, COMPRESSED_EXTENSIONS.has(extension(entry.name)) ? 0 : 6)
        }
      }
      ancestors.delete(folder)
    }
    try {
      await walk(dir, '')
      await zip.finish()
      res.end()
    } catch {
      res.destroy()
    }
  }

  function sameSecret(value) {
    const candidate = Buffer.from(String(value ?? ''))
    return candidate.length === secretBytes.length && timingSafeEqual(candidate, secretBytes)
  }

  function passwordMatches(header) {
    const value = String(header ?? '')
    if (!value.startsWith('Basic ') || value.length > 4096) return false
    const credentials = Buffer.from(value.slice(6), 'base64').toString('utf8')
    const separator = credentials.indexOf(':')
    if (separator < 0) return false
    return timingSafeEqual(sha256(credentials.slice(separator + 1)), passwordDigest)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) plain(res, 500, 'Internal error')
      else res.destroy()
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve() })
  })
  return {
    host: '127.0.0.1',
    port: server.address().port,
    path: base,
    name,
    root: realRoot,
    isFile,
    close: () => new Promise(resolve => {
      server.close(() => resolve())
      for (const socket of sockets) socket.destroy()
    }),
  }
}

function sendFile(req, res, file, stat, name, download) {
  const type = contentTypeFor(name)
  const viewable = /^(image|video|audio|text)\//.test(type) || type.startsWith('application/pdf') || type.startsWith('application/json')
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  const lastModified = stat.mtime.toUTCString()
  const headers = {
    ...BASE_HEADERS,
    'content-type': type,
    'accept-ranges': 'bytes',
    etag,
    'last-modified': lastModified,
    'content-disposition': disposition(download || !viewable ? 'attachment' : 'inline', name),
  }
  // Shared HTML and SVG render without scripts, forms or same-origin access.
  if (/^(text\/html|image\/svg\+xml)/.test(type)) headers['content-security-policy'] = 'sandbox'
  const ifRange = req.headers['if-range']
  const range = req.headers.range && (!ifRange || ifRange === etag || ifRange === lastModified) ? parseRange(req.headers.range, stat.size) : null
  if (!range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    return res.end()
  }
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` })
    return res.end()
  }
  const start = range ? range.start : 0
  const end = range ? range.end : stat.size - 1
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': String(Math.max(0, end - start + 1)),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
  })
  if (req.method === 'HEAD' || stat.size === 0) return res.end()
  // pipeline also closes the file when the visitor disconnected while the path was resolved.
  pipeline(fs.createReadStream(file, { start, end }), res).catch(() => res.destroy())
}

function sendListing(req, res, { name, segments, items, base, isFile, expiresAt }) {
  const nonce = randomBytes(12).toString('base64')
  const body = Buffer.from(renderListing({ name, segments, items, base, isFile, expiresAt, nonce }))
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const FOLDER_ICON = `<svg class="icon dir" ${ICON_ATTRS}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`
const FILE_ICON = `<svg class="icon" ${ICON_ATTRS}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`

function renderListing({ name, segments, items, base, isFile, expiresAt, nonce }) {
  const here = base + segments.map(seg => `${encodeURIComponent(seg)}/`).join('')
  const crumbs = [`<a href="${base}">${escapeHtml(name)}</a>`]
  segments.forEach((seg, index) => {
    crumbs.push(`<a href="${base}${segments.slice(0, index + 1).map(s => `${encodeURIComponent(s)}/`).join('')}">${escapeHtml(seg)}</a>`)
  })
  items.sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const rows = items.map(item => {
    const href = here + encodeURIComponent(item.name) + (item.isDir ? '/' : '')
    const action = item.isDir ? `<a class="act" href="${href}?zip=1">ZIP</a>` : `<a class="act" href="${href}?download=1" download>Download</a>`
    const modified = new Date(item.mtime)
    return `<tr data-name="${escapeHtml(item.name.toLowerCase())}" data-dir="${item.isDir ? 1 : 0}" data-size="${item.size}" data-mtime="${Math.floor(item.mtime)}">`
      + `<td class="name">${item.isDir ? FOLDER_ICON : FILE_ICON}<a href="${href}">${escapeHtml(item.name)}${item.isDir ? '/' : ''}</a></td>`
      + `<td class="size">${item.isDir ? '—' : formatBytes(item.size)}</td>`
      + `<td class="mtime"><time datetime="${modified.toISOString()}">${modified.toISOString().slice(0, 16).replace('T', ' ')} UTC</time></td>`
      + `<td class="actions">${action}</td></tr>`
  }).join('\n')
  const title = segments.length ? `${segments[segments.length - 1]} — ${name}` : name
  const zipAll = isFile ? '' : `<a class="button" href="${here}?zip=1">Download folder (ZIP)</a>`
  const expires = expiresAt ? ` · expires <time class="local" datetime="${new Date(expiresAt).toISOString()}">${new Date(expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --fg: #111827; --muted: #6b7280; --bg: #ffffff; --line: #e5e7eb; --hover: #f3f4f6; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --fg: #e5e7eb; --muted: #9ca3af; --bg: #0b0f17; --line: #1f2937; --hover: #111827; --accent: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
nav { font-size: 18px; font-weight: 600; word-break: break-word; }
nav a { color: inherit; text-decoration: none; }
nav a:hover { text-decoration: underline; }
nav .sep { color: var(--muted); margin: 0 6px; }
.tools { display: flex; gap: 8px; flex-wrap: wrap; }
input[type=search] { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; min-width: 200px; font: inherit; }
.button { display: inline-block; padding: 7px 12px; border-radius: 8px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 500; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 13px; color: var(--muted); font-weight: 500; user-select: none; }
th[data-sort] { cursor: pointer; }
th[data-sort]:hover { color: var(--fg); }
th.asc::after { content: " ▲"; } th.desc::after { content: " ▼"; }
tbody tr:hover { background: var(--hover); }
td.name a { color: var(--accent); text-decoration: none; word-break: break-word; }
td.name a:hover { text-decoration: underline; }
.icon { width: 18px; height: 18px; margin-right: 8px; vertical-align: -3px; color: var(--muted); }
.icon.dir { color: var(--accent); }
td.size, td.mtime { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
td.actions { text-align: right; white-space: nowrap; }
.act { color: var(--muted); font-size: 13px; text-decoration: none; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; }
.act:hover { color: var(--fg); }
.empty { color: var(--muted); padding: 24px 0; }
footer { margin-top: 24px; color: var(--muted); font-size: 13px; }
footer a { color: inherit; }
@media (max-width: 640px) { td.mtime, th.mtime { display: none; } }
</style>
</head>
<body>
<main>
<header>
<nav>${crumbs.join('<span class="sep">/</span>')}</nav>
<div class="tools">${items.length > 1 ? '<input type="search" id="filter" placeholder="Search" aria-label="Search files">' : ''}${zipAll}</div>
</header>
${items.length ? `<table>
<thead><tr><th data-sort="name">Name</th><th data-sort="size">Size</th><th data-sort="mtime" class="mtime">Modified</th><th></th></tr></thead>
<tbody id="rows">
${rows}
</tbody>
</table>
<p class="empty" id="nomatch" hidden>No matching files.</p>` : '<p class="empty">This folder is empty.</p>'}
<footer>Read-only share via <a href="https://portpreview.com" rel="noopener noreferrer">PortPreview</a>${expires}</footer>
</main>
<script nonce="${nonce}">
(() => {
  const rows = document.getElementById('rows')
  for (const el of document.querySelectorAll('time')) {
    const date = new Date(el.dateTime)
    if (!isNaN(date)) el.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  if (!rows) return
  const all = [...rows.rows]
  const filter = document.getElementById('filter')
  const nomatch = document.getElementById('nomatch')
  filter?.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase()
    let shown = 0
    for (const row of all) { const hit = !q || row.dataset.name.includes(q); row.hidden = !hit; if (hit) shown++ }
    nomatch.hidden = shown > 0
  })
  let key = null, dir = 1
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      dir = key === th.dataset.sort ? -dir : 1
      key = th.dataset.sort
      for (const other of document.querySelectorAll('th[data-sort]')) other.classList.remove('asc', 'desc')
      th.classList.add(dir > 0 ? 'asc' : 'desc')
      const value = row => key === 'name' ? row.dataset.name : Number(row.dataset[key])
      all.sort((a, b) => (b.dataset.dir - a.dataset.dir) || (key === 'name'
        ? dir * value(a).localeCompare(value(b), undefined, { numeric: true })
        : dir * (value(a) - value(b))))
      rows.append(...all)
    })
  }
})()
</script>
</body>
</html>
`
}

/**
 * Streaming ZIP writer: deflate with data descriptors (sizes and CRC follow each entry), UTF-8
 * names, ZIP64 when an entry, an offset or the entry count outgrows the classic format.
 */
export function createZipWriter(out) {
  let offset = 0
  const central = []
  const write = async (buffer) => {
    // A destroyed response never emits 'drain' or 'close' again: stop instead of waiting forever.
    if (out.destroyed) throw new Error('Client disconnected')
    offset += buffer.length
    if (!out.write(buffer)) await drained(out)
  }
  return {
    async directory(name, mtime) {
      const entry = { name: Buffer.from(name), mtime, method: 0, crc: 0, size: 0, compressed: 0, offset, dir: true, zip64: false }
      await write(localHeader(entry))
      central.push(entry)
    },
    async file(name, file, stat, level = 6) {
      // Open first: an unreadable file is skipped before any of its bytes are written.
      const handle = await fsp.open(file, 'r').catch(() => null)
      if (!handle) return
      const entry = { name: Buffer.from(name), mtime: stat.mtime, method: 8, crc: 0, size: 0, compressed: 0, offset, dir: false, zip64: stat.size >= 0xF0000000 }
      try { await write(localHeader(entry)) }
      catch (error) { await handle.close().catch(() => {}); throw error }
      const checksum = new Transform({
        transform(chunk, _encoding, callback) { entry.crc = crc32(chunk, entry.crc); entry.size += chunk.length; callback(null, chunk) },
      })
      try {
        await pipeline(handle.createReadStream({ highWaterMark: 256 * 1024 }), checksum, zlib.createDeflateRaw({ level }), async function (source) {
          for await (const chunk of source) { entry.compressed += chunk.length; await write(chunk) }
        })
      } finally { await handle.close().catch(() => {}) }
      if (!entry.zip64 && (entry.size >= 0xFFFFFFFF || entry.compressed >= 0xFFFFFFFF)) throw new Error(`${name} grew past 4 GB while zipping`)
      const descriptor = Buffer.alloc(entry.zip64 ? 24 : 16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(entry.crc, 4)
      if (entry.zip64) { descriptor.writeBigUInt64LE(BigInt(entry.compressed), 8); descriptor.writeBigUInt64LE(BigInt(entry.size), 16) }
      else { descriptor.writeUInt32LE(entry.compressed, 8); descriptor.writeUInt32LE(entry.size, 12) }
      await write(descriptor)
      central.push(entry)
    },
    async finish() {
      const start = offset
      for (const entry of central) await write(centralHeader(entry))
      const size = offset - start
      const count = central.length
      if (count >= 0xFFFF || start >= 0xFFFFFFFF || size >= 0xFFFFFFFF) {
        const record = Buffer.alloc(56)
        record.writeUInt32LE(0x06064b50, 0)
        record.writeBigUInt64LE(44n, 4)
        record.writeUInt16LE(45, 12)
        record.writeUInt16LE(45, 14)
        record.writeBigUInt64LE(BigInt(count), 24)
        record.writeBigUInt64LE(BigInt(count), 32)
        record.writeBigUInt64LE(BigInt(size), 40)
        record.writeBigUInt64LE(BigInt(start), 48)
        const locator = Buffer.alloc(20)
        locator.writeUInt32LE(0x07064b50, 0)
        locator.writeBigUInt64LE(BigInt(offset), 8)
        locator.writeUInt32LE(1, 16)
        await write(Buffer.concat([record, locator]))
      }
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(Math.min(count, 0xFFFF), 8)
      end.writeUInt16LE(Math.min(count, 0xFFFF), 10)
      end.writeUInt32LE(Math.min(size, 0xFFFFFFFF), 12)
      end.writeUInt32LE(Math.min(start, 0xFFFFFFFF), 16)
      await write(end)
    },
  }
}

function localHeader(entry) {
  const extra = entry.zip64 ? Buffer.alloc(20) : Buffer.alloc(0)
  if (entry.zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2) }
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(entry.zip64 ? 45 : 20, 4)
  header.writeUInt16LE(entry.dir ? 0x0800 : 0x0808, 6)
  header.writeUInt16LE(entry.method, 8)
  const { time, date } = dosDateTime(entry.mtime)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  if (entry.zip64) { header.writeUInt32LE(0xFFFFFFFF, 18); header.writeUInt32LE(0xFFFFFFFF, 22) }
  header.writeUInt16LE(entry.name.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, entry.name, extra])
}

function centralHeader(entry) {
  const sizes64 = entry.zip64
  const offset64 = entry.offset >= 0xFFFFFFFF
  const fields = [...(sizes64 ? [entry.size, entry.compressed] : []), ...(offset64 ? [entry.offset] : [])]
  const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0)
  if (fields.length) {
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(fields.length * 8, 2)
    fields.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8))
  }
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE((3 << 8) | 45, 4)
  header.writeUInt16LE(sizes64 || offset64 ? 45 : 20, 6)
  header.writeUInt16LE(entry.dir ? 0x0800 : 0x0808, 8)
  header.writeUInt16LE(entry.method, 10)
  const { time, date } = dosDateTime(entry.mtime)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(sizes64 ? 0xFFFFFFFF : entry.compressed, 20)
  header.writeUInt32LE(sizes64 ? 0xFFFFFFFF : entry.size, 24)
  header.writeUInt16LE(entry.name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt32LE((((entry.dir ? 0o40755 : 0o100644) << 16) | (entry.dir ? 0x10 : 0)) >>> 0, 38)
  header.writeUInt32LE(offset64 ? 0xFFFFFFFF : entry.offset, 42)
  return Buffer.concat([header, entry.name, extra])
}

function dosDateTime(value) {
  const date = new Date(value)
  if (!(date.getFullYear() >= 1980)) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.min(date.getFullYear(), 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

let crcTable
export function crc32(buffer, previous = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer, previous)
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let crc = (previous ^ 0xFFFFFFFF) >>> 0
  for (let i = 0; i < buffer.length; i++) crc = crcTable[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function drained(stream) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('Client disconnected')) }
    const cleanup = () => { stream.off('drain', done); stream.off('close', closed) }
    stream.once('drain', done)
    stream.once('close', closed)
  })
}

function invalidSegment(segment) {
  return segment === '' || segment === '.' || segment === '..' || /[/\\\0]/.test(segment)
    || (process.platform === 'win32' && (/[:*?"<>|]/.test(segment) || /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i.test(segment)))
}

function extension(name) {
  const base = String(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function disposition(kind, name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

function plain(res, status, message) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

function redirect(res, location) {
  res.writeHead(301, { ...BASE_HEADERS, location })
  res.end()
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest()
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
