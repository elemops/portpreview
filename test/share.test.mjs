import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import zlib from 'node:zlib'
import { parseArgs } from '../lib/config.mjs'
import { crc32, createZipWriter, isHiddenName, parseDuration, parseRange, startShareServer } from '../lib/share-server.mjs'

const SECRET = 'testsecret0123456789ab'

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portpreview-share-'))
  const root = path.join(dir, 'shared')
  fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, 'empty'))
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world')
  fs.writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>')
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)))
  fs.writeFileSync(path.join(root, 'Привіт світ.md'), '# hi')
  fs.writeFileSync(path.join(root, 'docs', 'a.json'), '{"a":1}')
  fs.writeFileSync(path.join(root, 'docs', 'nested', 'b.txt'), 'b'.repeat(5000))
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(root, 'server.pem'), 'key')
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]')
  if (process.platform !== 'win32') fs.writeFileSync(path.join(root, '..\\..\\evil.bat'), 'echo')
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside')
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(root, 'escape.txt'))
  fs.symlinkSync(dir, path.join(root, 'escape-dir'))
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'env-link.txt'))
  fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'docs-link'))
  fs.symlinkSync(root, path.join(root, 'docs', 'loop'))
  return { dir, root }
}

function get(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, async (res) => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
    })
    req.once('error', reject)
    req.end()
  })
}

/** Minimal reader: walks the central directory, inflates every entry and checks CRC and sizes. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'end of central directory')
  const count = buffer.readUInt16LE(end + 10)
  let pointer = buffer.readUInt32LE(end + 16)
  const entries = {}
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50)
    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const crc = buffer.readUInt32LE(pointer + 16)
    const compressed = buffer.readUInt32LE(pointer + 20)
    const size = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const local = buffer.readUInt32LE(pointer + 42)
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    assert.ok(flags & 0x0800, 'UTF-8 flag')
    assert.equal(buffer.readUInt32LE(local), 0x04034b50)
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(dataStart, dataStart + compressed)
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw
    assert.equal(data.length, size, `${name} size`)
    assert.equal(crc32(data), crc, `${name} crc`)
    entries[name] = data
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('share helpers', () => {
  it('hides dot-files and key material', () => {
    for (const name of ['.env', '.git', '.ssh', '.npmrc', 'id_rsa', 'key4.db', 'terraform.tfstate', 'prod.tfstate.backup', 'vpn.ovpn', 'id_ed25519', 'server.PEM', 'cert.key', 'store.p12', 'prod.env', 'vault.kdbx']) assert.equal(isHiddenName(name), true, name)
    for (const name of ['readme.md', 'photo.jpg', 'keys.txt', 'id_rsa.pub', 'environment.ts']) assert.equal(isHiddenName(name), false, name)
  })

  it('parses single byte ranges', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
    assert.deepEqual(parseRange('bytes=95-200', 100), { start: 95, end: 99 })
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
    assert.equal(parseRange('bytes=0-1,5-6', 100), null)
    assert.equal(parseRange('items=0-1', 100), null)
  })

  it('parses durations', () => {
    assert.equal(parseDuration('30m'), 1_800_000)
    assert.equal(parseDuration('2h'), 7_200_000)
    assert.equal(parseDuration('1d'), 86_400_000)
    assert.equal(parseDuration('45'), 2_700_000)
    assert.equal(parseDuration('0m'), null)
    assert.equal(parseDuration('soon'), null)
  })

  it('matches the zlib CRC-32', () => {
    const data = Buffer.from('The quick brown fox jumps over the lazy dog')
    assert.equal(crc32(data), 0x414fa339)
    assert.equal(crc32(data.subarray(10), crc32(data.subarray(0, 10))), 0x414fa339)
  })

  it('writes ZIP64 records when the entry count overflows the classic format', async () => {
    const out = new PassThrough()
    const chunks = []
    out.on('data', chunk => chunks.push(chunk))
    const zip = createZipWriter(out)
    for (let i = 0; i < 0xFFFF; i++) await zip.directory(`d${i}/`, new Date())
    await zip.finish()
    const buffer = Buffer.concat(chunks)
    const end = buffer.length - 22
    assert.equal(buffer.readUInt16LE(end + 10), 0xFFFF)
    assert.equal(buffer.readUInt32LE(end - 20), 0x07064b50)
    const record = Number(buffer.readBigUInt64LE(end - 12))
    assert.equal(buffer.readUInt32LE(record), 0x06064b50)
    assert.equal(Number(buffer.readBigUInt64LE(record + 32)), 0xFFFF)
  })
})

describe('share config', () => {
  it('parses share options', () => {
    const opts = parseArgs(['share', './dist', '--password', 'pw', '--expires', '2h', '--include-hidden', '--quiet'])
    assert.equal(opts.kind, 'share')
    assert.equal(opts.sharePath, './dist')
    assert.equal(opts.password, 'pw')
    assert.equal(opts.expiresInMs, 7_200_000)
    assert.equal(opts.includeHidden, true)
    assert.equal(opts.inspect, false)
  })

  it('rejects bad share usage', () => {
    assert.throws(() => parseArgs(['share']), /Missing path/)
    assert.throws(() => parseArgs(['share', 'a', 'b']), /Unexpected argument/)
    assert.throws(() => parseArgs(['share', '.', '--expires', '8d']), /at most 7d/)
    assert.throws(() => parseArgs(['share', '.', '--expires', 'later']), /Invalid --expires/)
    assert.throws(() => parseArgs(['share', '.', '--host', '0.0.0.0']), /does not use --host/)
    assert.throws(() => parseArgs(['3000', '--password', 'x']), /only with portpreview share/)
  })
})

describe('share server', () => {
  let tree, share
  const base = `/s/${SECRET}/`
  before(async () => {
    tree = makeTree()
    share = await startShareServer({ root: tree.root, secret: SECRET })
  })
  after(async () => {
    await share.close()
    fs.rmSync(tree.dir, { recursive: true, force: true })
  })

  it('answers 404 outside the secret prefix', async () => {
    for (const urlPath of ['/', '/hello.txt', '/s/', '/s/wrong/', `/s/${SECRET.slice(0, -1)}x/`, '/favicon.ico', `/x/${SECRET}/`]) {
      const res = await get(share.port, urlPath)
      assert.equal(res.status, 404, urlPath)
      assert.equal(res.body.toString(), 'Not found')
    }
    const bare = await get(share.port, `/s/${SECRET}`)
    assert.equal(bare.status, 301)
    assert.equal(bare.headers.location, base)
  })

  it('lists a folder without hidden or escaping entries', async () => {
    const res = await get(share.port, base)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.match(res.headers['content-security-policy'], /script-src 'nonce-/)
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
    const html = res.body.toString()
    for (const name of ['hello.txt', 'docs/', 'empty/', 'docs-link/', 'Привіт світ.md']) assert.ok(html.includes(`>${name}</a>`), name)
    for (const name of ['.env', '.git', 'server.pem', 'escape.txt', 'escape-dir', 'env-link.txt']) assert.ok(!html.includes(name), name)
    assert.ok(html.includes('?zip=1'))
  })

  it('serves files inline with ranges, validators and HEAD', async () => {
    const res = await get(share.port, `${base}hello.txt`)
    assert.equal(res.status, 200)
    assert.equal(res.body.toString(), 'hello world')
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
    assert.match(res.headers['content-disposition'], /^inline; filename="hello.txt"/)
    assert.equal(res.headers['accept-ranges'], 'bytes')

    const ranged = await get(share.port, `${base}hello.txt`, { range: 'bytes=6-' })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['content-range'], 'bytes 6-10/11')
    assert.equal(ranged.body.toString(), 'world')

    const stale = await get(share.port, `${base}hello.txt`, { range: 'bytes=6-', 'if-range': '"other"' })
    assert.equal(stale.status, 200)
    assert.equal(stale.body.length, 11)

    const unsatisfiable = await get(share.port, `${base}hello.txt`, { range: 'bytes=50-' })
    assert.equal(unsatisfiable.status, 416)
    assert.equal(unsatisfiable.headers['content-range'], 'bytes */11')

    const cached = await get(share.port, `${base}hello.txt`, { 'if-none-match': res.headers.etag })
    assert.equal(cached.status, 304)

    const head = await get(share.port, `${base}blob.bin`, {}, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], '1000')
    assert.equal(head.body.length, 0)

    const download = await get(share.port, `${base}hello.txt?download=1`)
    assert.match(download.headers['content-disposition'], /^attachment;/)

    const unicode = await get(share.port, `${base}${encodeURIComponent('Привіт світ.md')}`)
    assert.equal(unicode.body.toString(), '# hi')
    assert.match(unicode.headers['content-disposition'], /filename\*=UTF-8''%D0%9F/)
  })

  it('sandboxes shared HTML and downloads unknown types', async () => {
    const html = await get(share.port, `${base}page.html`)
    assert.equal(html.headers['content-security-policy'], 'sandbox')
    const blob = await get(share.port, `${base}blob.bin`)
    assert.equal(blob.headers['content-type'], 'application/octet-stream')
    assert.match(blob.headers['content-disposition'], /^attachment;/)
  })

  it('refuses traversal, hidden files and symlinks out of the share', async () => {
    for (const urlPath of [
      `${base}../outside.txt`, `${base}..%2Foutside.txt`, `${base}%2e%2e/outside.txt`, `${base}docs/..%2F..%2Foutside.txt`,
      `${base}.env`, `${base}.git/config`, `${base}server.pem`, `${base}escape.txt`, `${base}escape-dir/outside.txt`,
      `${base}env-link.txt`, `${base}docs//a.json`, `${base}missing.txt`, `${base}hello.txt/`, `${base}%00`,
    ]) {
      const res = await get(share.port, urlPath)
      assert.ok([400, 404].includes(res.status), `${urlPath} → ${res.status}`)
      assert.ok(!res.body.toString().includes('outside') && !res.body.toString().includes('SECRET'), urlPath)
    }
  })

  it('redirects folders to a trailing slash and follows symlinks inside the share', async () => {
    const res = await get(share.port, `${base}docs`)
    assert.equal(res.status, 301)
    assert.equal(res.headers.location, `${base}docs/`)
    const linked = await get(share.port, `${base}docs-link/a.json`)
    assert.equal(linked.status, 200)
    assert.equal(linked.body.toString(), '{"a":1}')
  })

  it('is read-only', async () => {
    const res = await get(share.port, `${base}hello.txt`, {}, 'PUT')
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, HEAD')
  })

  it('zips a folder without hidden files, escaping links or loops', async () => {
    const res = await get(share.port, `${base}?zip=1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/zip')
    assert.match(res.headers['content-disposition'], /attachment; filename="shared.zip"/)
    const entries = readZip(res.body)
    assert.equal(entries['hello.txt'].toString(), 'hello world')
    assert.equal(entries['docs/nested/b.txt'].toString(), 'b'.repeat(5000))
    assert.equal(entries['Привіт світ.md'].toString(), '# hi')
    assert.ok('empty/' in entries)
    assert.ok('docs-link/a.json' in entries)
    for (const name of Object.keys(entries)) {
      assert.ok(!/(^|\/)\.env|\.git\/|server\.pem|escape|env-link|outside/.test(name), name)
      assert.ok(!name.startsWith('docs/loop/'), name)
      assert.ok(!name.includes('\\'), name)
    }
    const sub = readZip((await get(share.port, `${base}docs/?zip=1`)).body)
    assert.equal(sub['a.json'].toString(), '{"a":1}')
    assert.ok('nested/b.txt' in sub)
    // docs/loop points back at the share root: it is walked once, never back into docs itself.
    assert.ok(!Object.keys(sub).some(name => name.startsWith('loop/docs/')))
  })

  it('shares hidden files only with includeHidden', async () => {
    const open = await startShareServer({ root: tree.root, secret: SECRET, includeHidden: true })
    try {
      assert.equal((await get(open.port, `${base}.env`)).body.toString(), 'SECRET=1')
      assert.equal((await get(open.port, `${base}escape.txt`)).status, 404)
    } finally { await open.close() }
  })

  it('asks for the password after the secret', async () => {
    const locked = await startShareServer({ root: tree.root, secret: SECRET, password: 'p4ss' })
    try {
      assert.equal((await get(locked.port, '/')).status, 404)
      const challenge = await get(locked.port, base)
      assert.equal(challenge.status, 401)
      assert.match(challenge.headers['www-authenticate'], /^Basic realm="PortPreview share"/)
      const wrong = await get(locked.port, base, { authorization: `Basic ${Buffer.from('x:nope').toString('base64')}` })
      assert.equal(wrong.status, 401)
      const ok = await get(locked.port, `${base}hello.txt`, { authorization: `Basic ${Buffer.from('anyone:p4ss').toString('base64')}` })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.toString(), 'hello world')
    } finally { await locked.close() }
  })

  it('stops serving after expiry', async () => {
    const expired = await startShareServer({ root: tree.root, secret: SECRET, expiresAt: Date.now() - 1 })
    try { assert.equal((await get(expired.port, base)).status, 410) }
    finally { await expired.close() }
  })

  it('shares a single file', async () => {
    const single = await startShareServer({ root: path.join(tree.root, 'hello.txt'), secret: SECRET })
    try {
      assert.equal(single.isFile, true)
      const listing = (await get(single.port, base)).body.toString()
      assert.ok(listing.includes('>hello.txt</a>'))
      assert.ok(!listing.includes('?zip=1'))
      assert.equal((await get(single.port, `${base}hello.txt`)).body.toString(), 'hello world')
      assert.equal((await get(single.port, `${base}page.html`)).status, 404)
    } finally { await single.close() }
  })

  it('refuses a whole home folder or drive', async () => {
    await assert.rejects(startShareServer({ root: os.homedir() }), /whole home folder/)
    await assert.rejects(startShareServer({ root: path.parse(process.cwd()).root }), /whole drive/)
  })

  it('fails clearly for a missing path', async () => {
    await assert.rejects(startShareServer({ root: path.join(tree.dir, 'nope') }), /Path not found/)
  })
})
