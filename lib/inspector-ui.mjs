/**
 * Single-page inspector UI: inline CSS and JS, no framework, no external assets.
 * Captured data is rendered with textContent only. The inline script avoids backticks and
 * dollar-brace sequences so it can live inside this template literal (String.raw keeps its
 * backslash escapes intact).
 * @param {{ nonce: string }} options
 */
export function renderInspectorPage({ nonce }) {
  const n = String(nonce).replace(/[^A-Za-z0-9+/=]/g, '')
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>PortPreview Inspector</title>
<link rel="icon" href="data:,">
<style nonce="${n}">
:root { --bg: #f7f7f8; --panel: #fff; --line: #e3e3e8; --text: #1d1d22; --muted: #6b6b76; --accent: #3a5bd9; --ok: #1f8a4c; --warn: #b26a00; --bad: #c0362c; --chip: #eef0f6; --sel: #e8edff; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root { --bg: #141417; --panel: #1c1c21; --line: #2e2e36; --text: #e8e8ee; --muted: #9a9aa6; --accent: #7d97ff; --ok: #4cc37f; --warn: #e0a043; --bad: #ff6b5e; --chip: #2a2a33; --sel: #262d48; } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); display: flex; flex-direction: column; }
button, select, input, textarea { font: inherit; color: inherit; }
button { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
select, input[type=search], input[type=text] { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
header.top { display: flex; align-items: center; gap: 14px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brand { font-weight: 650; font-size: 14px; }
.brand span { color: var(--muted); font-weight: 500; }
.meta { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.meta b { color: var(--text); font-weight: 500; }
.conn { font-size: 12px; color: var(--muted); }
.conn::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--warn); vertical-align: 0; }
.conn.live::before { background: var(--ok); }
.filters { display: flex; gap: 8px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.filters input[type=search] { width: 220px; }
.filters label { display: flex; align-items: center; gap: 5px; color: var(--muted); }
.filters .count { margin-left: auto; color: var(--muted); }
main { flex: 1; display: flex; min-height: 0; }
.list { width: 48%; min-width: 340px; overflow: auto; border-right: 1px solid var(--line); background: var(--panel); }
table { width: 100%; border-collapse: collapse; }
th { position: sticky; top: 0; background: var(--panel); text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; padding: 6px 8px; border-bottom: 1px solid var(--line); }
td { padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; font-family: var(--mono); font-size: 12px; }
td.path { max-width: 1px; width: 100%; overflow: hidden; text-overflow: ellipsis; }
tr.row { cursor: pointer; }
tr.row:hover td { background: var(--bg); }
tr.row.selected td { background: var(--sel); }
.s2 { color: var(--ok); } .s3 { color: var(--accent); } .s4 { color: var(--warn); } .s5, .serr { color: var(--bad); } .spend { color: var(--muted); }
.badge { display: inline-block; font-family: system-ui, sans-serif; font-size: 10px; padding: 0 5px; border-radius: 4px; background: var(--chip); color: var(--muted); margin-left: 5px; vertical-align: 1px; }
.badge.replay { color: var(--accent); }
.badge.trunc { color: var(--warn); }
.badge.edited { color: var(--accent); }
.empty, .placeholder { color: var(--muted); padding: 24px 16px; margin: 0; }
.detail { flex: 1; overflow: auto; padding: 14px 18px 40px; min-width: 0; }
.d-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.d-title { font-family: var(--mono); font-size: 14px; font-weight: 600; word-break: break-all; flex: 1; min-width: 200px; }
.d-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.d-meta { color: var(--muted); margin: 8px 0 4px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.d-meta a { color: var(--accent); cursor: pointer; text-decoration: underline; }
.note { margin: 8px 0; padding: 6px 10px; border-radius: 6px; background: var(--chip); color: var(--text); }
.note.bad { color: var(--bad); }
.note.warn { color: var(--warn); }
.tabs { display: flex; gap: 2px; margin: 14px 0 0; border-bottom: 1px solid var(--line); }
.tabs button, .views button { border: 0; border-radius: 0; background: none; padding: 6px 12px; color: var(--muted); border-bottom: 2px solid transparent; }
.tabs button.on, .views button.on { color: var(--text); border-bottom-color: var(--accent); }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); margin: 16px 0 6px; font-weight: 600; }
table.headers td { white-space: normal; word-break: break-all; vertical-align: top; }
table.headers td.name { width: 30%; color: var(--muted); }
.mask { font-family: var(--mono); font-size: 12px; padding: 0 6px; }
.bodybar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 16px 0 6px; }
.bodybar h3 { margin: 0; }
.views { display: flex; }
.bodyinfo { color: var(--muted); font-size: 12px; }
.bodybar a { color: var(--accent); font-size: 12px; }
pre { margin: 0; padding: 10px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-all; max-height: 60vh; overflow: auto; }
pre.hex { white-space: pre; word-break: normal; }
footer { padding: 6px 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; background: var(--panel); display: flex; gap: 12px; flex-wrap: wrap; }
footer .stats { margin-left: auto; }
.toast { position: fixed; right: 16px; bottom: 40px; max-width: 420px; background: var(--text); color: var(--bg); padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.2); }
.copybox { margin-top: 10px; }
.copybox textarea { width: 100%; min-height: 120px; font: 12px var(--mono); background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
dialog.editor { width: min(940px, 94vw); max-height: 92vh; padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); box-shadow: 0 14px 44px rgba(0,0,0,.3); }
dialog.editor::backdrop { background: rgba(12,12,16,.45); }
.ed { display: flex; flex-direction: column; gap: 6px; padding: 16px 18px 14px; }
.ed h2 { font-size: 15px; margin: 0; font-weight: 650; }
.ed-sub { color: var(--muted); margin: 0 0 6px; }
.ed-line { display: flex; gap: 8px; }
.ed-line input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; }
.ed-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); font-weight: 600; margin: 10px 0 0; }
.ed-label span { text-transform: none; letter-spacing: 0; font-weight: 400; }
.ed textarea { width: 100%; font: 12px/1.5 var(--mono); background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 8px; resize: vertical; }
.ed-hint { color: var(--muted); font-size: 12px; }
.ed-bodybar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.ed-bodybar .ed-label { margin: 0; }
.ed-bodybar .bodyinfo { margin-right: auto; }
.ed .note { margin: 2px 0; }
.ed-confirm { display: flex; align-items: center; gap: 6px; color: var(--warn); }
.ed-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 8px; }
.ed-actions .ed-hint { margin-right: auto; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 860px) { main { flex-direction: column; } .list { width: auto; min-width: 0; max-height: 45vh; border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
</head>
<body>
<header class="top">
  <div class="brand">PortPreview <span>Inspector</span></div>
  <div class="meta" id="meta">Loading…</div>
  <div class="conn" id="conn">Connecting…</div>
  <button id="clear" type="button" title="Remove every captured request from memory">Clear</button>
</header>
<div class="filters">
  <select id="f-method" aria-label="Method">
    <option value="">All methods</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option><option value="WS">WebSocket</option>
  </select>
  <select id="f-status" aria-label="Status">
    <option value="">All statuses</option><option value="2">2xx</option><option value="3">3xx</option><option value="4">4xx</option><option value="5">5xx</option><option value="err">Errors</option><option value="pending">In flight</option>
  </select>
  <input id="f-path" type="search" placeholder="Filter by path" aria-label="Path contains">
  <label><input id="f-static" type="checkbox"> Hide static assets</label>
  <span class="count" id="count"></span>
</div>
<main>
  <section class="list">
    <table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Size</th></tr></thead><tbody id="rows"></tbody></table>
    <p class="empty" id="empty">No requests yet. Requests that reach this CLI through the tunnel appear here as they arrive.</p>
  </section>
  <section class="detail" id="detail"><p class="placeholder">Select a request to see its headers and body.</p></section>
</main>
<footer>
  <span>Only requests that reached this CLI are listed. Requests the gateway rejected (body too large, preview password, IP allowlist, tunnel offline) never arrive here.</span>
  <span>Captured data stays in this process's memory and is gone when the CLI exits.</span>
  <span class="stats" id="stats"></span>
</footer>
<div class="toast" id="toast" hidden></div>
<dialog class="editor" id="editor" aria-labelledby="ed-title">
  <div class="ed">
    <h2 id="ed-title">Edit &amp; replay</h2>
    <p class="ed-sub" id="ed-sub"></p>
    <div class="ed-line">
      <label class="sr" for="ed-method">Method</label>
      <select id="ed-method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option></select>
      <label class="sr" for="ed-path">Path and query</label>
      <input id="ed-path" type="text" spellcheck="false" autocomplete="off">
    </div>
    <div id="ed-method-note"></div>
    <label class="ed-label" for="ed-headers">Headers <span>(one "name: value" per line)</span></label>
    <textarea id="ed-headers" rows="9" spellcheck="false" wrap="off"></textarea>
    <div class="ed-hint">Host, Connection, Content-Length and Transfer-Encoding are always set by the inspector; lines for them are ignored.</div>
    <div class="ed-bodybar">
      <label class="ed-label" for="ed-body">Body</label>
      <span class="bodyinfo" id="ed-bodyinfo"></span>
      <select id="ed-eol" aria-label="Line endings" hidden><option value="crlf">CRLF line endings</option><option value="lf">LF line endings</option></select>
      <button type="button" id="ed-astext" hidden>Edit as text</button>
      <button type="button" id="ed-restore" hidden>Restore captured body</button>
      <button type="button" id="ed-empty">Empty body</button>
    </div>
    <div id="ed-notes"></div>
    <textarea id="ed-body" rows="12" spellcheck="false"></textarea>
    <label class="ed-confirm" id="ed-confirm-row" hidden><input type="checkbox" id="ed-confirm"> Send this partial body as shown</label>
    <div class="note bad" id="ed-error" role="alert" hidden></div>
    <div class="ed-actions">
      <span class="ed-hint">Ctrl+Enter sends · Esc cancels</span>
      <button type="button" id="ed-cancel">Cancel</button>
      <button type="button" class="primary" id="ed-send">Send</button>
    </div>
  </div>
</dialog>
<script nonce="${n}">
(function () {
  'use strict';
  var MUTATE = { 'X-PortPreview-Inspector': '1', 'Content-Type': 'application/json' };
  var SECRET = { 'authorization': 1, 'proxy-authorization': 1, 'cookie': 1, 'set-cookie': 1, 'x-api-key': 1 };
  var CURL_OMIT = { 'host': 1, 'content-length': 1, 'connection': 1, 'keep-alive': 1, 'proxy-authenticate': 1, 'proxy-authorization': 1, 'te': 1, 'trailer': 1, 'transfer-encoding': 1, 'upgrade': 1, 'accept-encoding': 1 };
  var STATIC_EXT = /\.(?:m?js|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm)$/i;
  var STATIC_PREFIX = /^\/(?:_next\/static\/|_next\/image|@vite\/|@fs\/|@id\/|@react-refresh|node_modules\/|__vite_ping|assets\/|static\/|favicon)/i;
  var HEX_LIMIT = 4096;
  var EDIT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  var REGENERATED = { 'host': 1, 'connection': 1, 'content-length': 1, 'transfer-encoding': 1 };

  var entries = new Map();
  var selected = null;
  var detail = null;
  var tab = 'request';
  var view = 'pretty';
  var status = null;
  var revealed = new Set();
  var renderQueued = false;
  var detailTimer = null;
  var detailLoading = false;
  var detailDirty = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error((body && body.error) || ('HTTP ' + response.status));
        return body;
      });
    });
  }
  function toast(text, ms) {
    var node = $('toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.hidden = true; }, ms || 3500);
  }
  function fmtBytes(n) {
    if (n === null || n === undefined) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function pad(value, width) { value = String(value); while (value.length < width) value = '0' + value; return value; }
  function fmtTime(ms) {
    var d = new Date(ms);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
  }
  function fmtDuration(entry) {
    if (!entry.done) return '…';
    var ms = entry.durationMs;
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
  }
  function statusText(entry) {
    if (entry.status) return String(entry.status);
    if (entry.error) return 'ERR';
    return '…';
  }
  function statusClass(entry) {
    if (entry.status) return 's' + String(entry.status).charAt(0);
    return entry.error ? 'serr' : 'spend';
  }
  function bytesFrom64(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8(bytes, fatal) {
    try { return new TextDecoder('utf-8', { fatal: !!fatal }).decode(bytes); } catch (e) { return null; }
  }
  function looksBinary(text) { return /[\u0000-\u0008\u000e-\u001f]/.test(text); }

  // ---------- list ----------
  function matches(entry) {
    var method = $('f-method').value;
    if (method === 'WS' ? entry.kind !== 'websocket' : (method && (entry.method !== method || entry.kind === 'websocket'))) return false;
    var cls = $('f-status').value;
    if (cls === 'err' && !(entry.error || entry.status >= 500)) return false;
    if (cls === 'pending' && entry.done) return false;
    if (/^[2-5]$/.test(cls) && String(entry.status || '').charAt(0) !== cls) return false;
    var needle = $('f-path').value.trim().toLowerCase();
    if (needle && entry.path.toLowerCase().indexOf(needle) === -1) return false;
    if ($('f-static').checked) {
      var path = entry.path.split('?')[0];
      if (STATIC_EXT.test(path) || STATIC_PREFIX.test(path)) return false;
    }
    return true;
  }
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; renderList(); });
  }
  function renderList() {
    var rows = $('rows');
    var fragment = document.createDocumentFragment();
    var ids = Array.from(entries.keys()).sort(function (a, b) { return b - a; });
    var shown = 0;
    ids.forEach(function (id) {
      var entry = entries.get(id);
      if (!matches(entry)) return;
      shown++;
      var tr = el('tr', 'row' + (id === selected ? ' selected' : ''));
      tr.dataset.id = String(id);
      tr.appendChild(el('td', '', fmtTime(entry.startedAt)));
      tr.appendChild(el('td', '', entry.kind === 'websocket' ? 'WS' : entry.method));
      var path = el('td', 'path', entry.path);
      path.title = entry.path;
      if (entry.source === 'replay') path.appendChild(el('span', 'badge replay', 'replay'));
      if (entry.edited) path.appendChild(el('span', 'badge edited', 'edited'));
      if (entry.request.truncated || entry.response.truncated) path.appendChild(el('span', 'badge trunc', 'truncated'));
      tr.appendChild(path);
      tr.appendChild(el('td', statusClass(entry), statusText(entry)));
      tr.appendChild(el('td', '', fmtDuration(entry)));
      tr.appendChild(el('td', '', entry.kind === 'websocket'
        ? (entry.websocket.framesIn + entry.websocket.framesOut) + ' frames'
        : fmtBytes(entry.response.bytes)));
      fragment.appendChild(tr);
    });
    clear(rows);
    rows.appendChild(fragment);
    $('empty').hidden = entries.size > 0;
    $('count').textContent = shown === entries.size ? entries.size + ' requests' : shown + ' of ' + entries.size + ' requests';
  }
  $('rows').addEventListener('click', function (event) {
    var tr = event.target.closest('tr.row');
    if (tr) select(Number(tr.dataset.id));
  });
  ['f-method', 'f-status', 'f-static'].forEach(function (id) { $(id).addEventListener('change', queueRender); });
  $('f-path').addEventListener('input', queueRender);

  // ---------- detail ----------
  function select(id) {
    if (selected !== id) { selected = id; detail = null; revealed.clear(); }
    queueRender();
    loadDetail();
  }
  function loadDetail() {
    if (selected === null) return;
    if (detailLoading) { detailDirty = true; return; }
    detailLoading = true;
    var id = selected;
    api('/api/requests/' + id).then(function (body) {
      if (id === selected) { detail = body; renderDetail(); }
    }).catch(function (error) {
      if (id === selected) { detail = null; renderMissing(error.message); }
    }).then(function () {
      detailLoading = false;
      if (detailDirty) { detailDirty = false; scheduleDetail(); }
    });
  }
  function scheduleDetail() {
    if (detailTimer) return;
    detailTimer = setTimeout(function () { detailTimer = null; loadDetail(); }, 400);
  }
  function renderMissing(message) {
    var root = $('detail');
    clear(root);
    root.appendChild(el('p', 'placeholder', message || 'Select a request to see its headers and body.'));
  }
  function link(text, id) {
    var a = el('a', '', text);
    a.addEventListener('click', function () { select(id); });
    return a;
  }
  function renderDetail() {
    var d = detail;
    var root = $('detail');
    var scroll = root.scrollTop;
    clear(root);
    var head = el('div', 'd-head');
    var title = el('div', 'd-title', (d.kind === 'websocket' ? 'WS' : d.method) + ' ' + d.path);
    head.appendChild(title);
    var actions = el('div', 'd-actions');
    if (d.kind !== 'websocket') {
      var replay = el('button', 'primary', 'Replay');
      replay.type = 'button';
      replay.disabled = !d.replayable;
      replay.title = d.replayable ? 'Send this exact request to the local app again' : d.replayBlockedReason;
      replay.addEventListener('click', function () { doReplay(d.id, replay); });
      actions.appendChild(replay);
      var edit = el('button', '', 'Edit & replay');
      edit.type = 'button';
      edit.id = 'd-edit';
      edit.title = 'Change the method, path, headers or body, then send it to the local app';
      edit.addEventListener('click', function () { openEditor(d, edit); });
      actions.appendChild(edit);
      var curlLocal = el('button', '', 'Copy cURL (local)');
      var curlPublic = el('button', '', 'Copy cURL (public URL)');
      var curlBlocked = d.request.truncated || !d.request.complete;
      [curlLocal, curlPublic].forEach(function (button, index) {
        button.type = 'button';
        button.disabled = curlBlocked || (index === 1 && !publicBase(d));
        button.title = curlBlocked ? 'The request body was not fully captured' : 'The command contains captured header values, which may include secrets';
        button.addEventListener('click', function () { copyCurl(d, index === 1 ? 'public' : 'local'); });
        actions.appendChild(button);
      });
    }
    head.appendChild(actions);
    root.appendChild(head);

    var meta = el('div', 'd-meta');
    meta.appendChild(el('span', '', '#' + d.id + ' · ' + new Date(d.startedAt).toLocaleString()));
    meta.appendChild(el('span', statusClass(d), 'Status ' + statusText(d)));
    meta.appendChild(el('span', '', 'Duration ' + fmtDuration(d)));
    if (d.protocolVersion) meta.appendChild(el('span', '', 'Protocol v' + d.protocolVersion));
    if (d.replayOf !== null) {
      var of = el('span', '', d.edited ? 'Edited replay of ' : 'Replay of ');
      of.appendChild(entries.has(d.replayOf) ? link('#' + d.replayOf, d.replayOf) : el('span', '', '#' + d.replayOf + ' (evicted)'));
      meta.appendChild(of);
    }
    if (d.replays.length) {
      var reps = el('span', '', 'Replays: ');
      d.replays.forEach(function (id, i) {
        if (i) reps.appendChild(document.createTextNode(', '));
        reps.appendChild(entries.has(id) ? link('#' + id, id) : el('span', '', '#' + id));
      });
      meta.appendChild(reps);
    }
    root.appendChild(meta);
    if (d.error) root.appendChild(el('div', 'note bad', 'Error: ' + d.error));
    if (d.synthetic) root.appendChild(el('div', 'note warn', 'The CLI generated this 502 because the local app could not be reached.'));

    if (d.kind === 'websocket') { renderWebSocket(root, d); root.scrollTop = scroll; return; }

    var tabs = el('div', 'tabs');
    ['request', 'response'].forEach(function (name) {
      var button = el('button', tab === name ? 'on' : '', name === 'request' ? 'Request' : 'Response');
      button.type = 'button';
      button.addEventListener('click', function () { tab = name; renderDetail(); });
      tabs.appendChild(button);
    });
    root.appendChild(tabs);
    var side = d[tab];
    if (tab === 'response' && !d.status) {
      root.appendChild(el('p', 'placeholder', d.done ? 'No response was received.' : 'Waiting for the response…'));
    } else {
      root.appendChild(el('h3', '', tab === 'request' ? 'Headers sent to the local app' : 'Headers from the local app'));
      root.appendChild(headerTable(side.headers, tab));
      renderBody(root, d, side, tab);
    }
    root.scrollTop = scroll;
  }
  function headerTable(pairs, sideName) {
    var table = el('table', 'headers');
    var body = el('tbody');
    if (!pairs.length) {
      var tr0 = el('tr');
      tr0.appendChild(el('td', 'name', '(none)'));
      body.appendChild(tr0);
    }
    pairs.forEach(function (pair, index) {
      var tr = el('tr');
      tr.appendChild(el('td', 'name', pair[0]));
      var value = el('td');
      var key = detail.id + ':' + sideName + ':' + index;
      if (SECRET[pair[0].toLowerCase()] && !revealed.has(key)) {
        var mask = el('button', 'mask', '•••••••• click to reveal');
        mask.type = 'button';
        mask.title = 'Hidden on screen; stored unmodified for replay';
        mask.addEventListener('click', function () { revealed.add(key); clear(value); value.textContent = pair[1]; });
        value.appendChild(mask);
      } else value.textContent = pair[1];
      tr.appendChild(value);
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }
  function renderBody(root, d, side, sideName) {
    var bar = el('div', 'bodybar');
    bar.appendChild(el('h3', '', 'Body'));
    var views = el('div', 'views');
    ['pretty', 'raw', 'hex'].forEach(function (name) {
      var button = el('button', view === name ? 'on' : '', name === 'pretty' ? 'Pretty' : name === 'raw' ? 'Raw' : 'Hex');
      button.type = 'button';
      button.addEventListener('click', function () { view = name; renderDetail(); });
      views.appendChild(button);
    });
    bar.appendChild(views);
    var info = fmtBytes(side.bytes);
    if (side.retained !== side.bytes) info += ', ' + fmtBytes(side.retained) + ' captured';
    bar.appendChild(el('span', 'bodyinfo', info));
    if (side.retained) {
      var download = el('a', '', 'Download');
      download.href = '/api/requests/' + d.id + '/body/' + sideName;
      download.setAttribute('download', 'request-' + d.id + '-' + sideName + '.bin');
      bar.appendChild(download);
    }
    root.appendChild(bar);
    if (side.truncated === 'limit') root.appendChild(el('div', 'note warn', 'Only the first ' + fmtBytes(side.retained) + ' of this body were captured (per-body limit). The app and the visitor still received all of it.'));
    else if (side.truncated === 'budget') root.appendChild(el('div', 'note warn', 'Capture stopped early because the inspector memory budget was full. The app and the visitor still received all of it.'));
    else if (side.truncated === 'tunnel') root.appendChild(el('div', 'note warn', 'The legacy v2 tunnel truncated this response to 1 MiB for the visitor.'));
    if (!side.complete && d.done && side.bytes) root.appendChild(el('div', 'note warn', 'This body did not finish (the transfer was cancelled or failed).'));
    if (!side.complete && !d.done && sideName === 'response' && d.status) root.appendChild(el('div', 'note', 'Still streaming…'));

    if (!side.retained) { root.appendChild(el('pre', '', side.bytes ? '(not captured)' : '(empty body)')); return; }
    var raw = bytesFrom64(side.base64);
    var shownBytes = raw;
    if (side.decodedBase64 && view !== 'hex') {
      shownBytes = bytesFrom64(side.decodedBase64);
      root.appendChild(el('div', 'note', 'Decoded from Content-Encoding: ' + side.contentEncoding + (side.decodedPartial ? ' (partial body)' : '') + '. Hex and Download show the raw bytes.'));
    } else if (side.decodeError && view !== 'hex') root.appendChild(el('div', 'note warn', side.decodeError));
    if (view === 'hex') { root.appendChild(el('pre', 'hex', hexDump(raw))); return; }
    if (view === 'raw') {
      var text = utf8(shownBytes, false);
      root.appendChild(el('pre', '', text));
      return;
    }
    root.appendChild(el('pre', '', pretty(shownBytes, side.contentType || '')));
  }
  function pretty(bytes, contentType) {
    var text = utf8(bytes, true);
    if (text === null || looksBinary(text)) return 'Binary body (' + fmtBytes(bytes.length) + '). Use Hex or Download.';
    var trimmed = text.trim();
    if (/json/i.test(contentType) || /^[\[{]/.test(trimmed)) {
      try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch (e) { }
    }
    if (/x-www-form-urlencoded/i.test(contentType)) {
      try {
        return trimmed.split('&').filter(Boolean).map(function (part) {
          var eq = part.indexOf('=');
          var key = eq === -1 ? part : part.slice(0, eq);
          var value = eq === -1 ? '' : part.slice(eq + 1);
          return decodeURIComponent(key.replace(/\+/g, ' ')) + ' = ' + decodeURIComponent(value.replace(/\+/g, ' '));
        }).join('\n');
      } catch (e) { }
    }
    return text;
  }
  function hexDump(bytes) {
    var lines = [];
    var n = Math.min(bytes.length, HEX_LIMIT);
    for (var i = 0; i < n; i += 16) {
      var hex = [];
      var ascii = '';
      for (var j = i; j < i + 16; j++) {
        if (j < n) {
          var b = bytes[j];
          hex.push((b < 16 ? '0' : '') + b.toString(16));
          ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
        } else hex.push('  ');
      }
      lines.push(pad(i.toString(16), 8) + '  ' + hex.slice(0, 8).join(' ') + '  ' + hex.slice(8).join(' ') + '  |' + ascii + '|');
    }
    if (bytes.length > HEX_LIMIT) lines.push('… first 4 KiB of ' + bytes.length + ' bytes shown. Use Download for the rest.');
    return lines.join('\n');
  }
  function renderWebSocket(root, d) {
    var ws = d.websocket;
    root.appendChild(el('h3', '', 'WebSocket'));
    var rows = [
      ['Frames visitor → app', ws.framesIn + ' (' + fmtBytes(ws.bytesIn) + ')'],
      ['Frames app → visitor', ws.framesOut + ' (' + fmtBytes(ws.bytesOut) + ')'],
      ['State', d.done ? 'closed' : (d.status === 101 ? 'open' : 'connecting')],
    ];
    if (ws.closeCode !== null) rows.push(['Close code', String(ws.closeCode) + (ws.closeReason ? ' ' + ws.closeReason : '')]);
    root.appendChild(headerTableStatic(rows));
    root.appendChild(el('div', 'note', 'Frame contents are not recorded yet. WebSocket connections cannot be replayed.'));
    root.appendChild(el('h3', '', 'Handshake headers sent to the local app'));
    root.appendChild(headerTable(d.request.headers, 'request'));
    if (d.response.headers.length) {
      root.appendChild(el('h3', '', 'Handshake response headers'));
      root.appendChild(headerTable(d.response.headers, 'response'));
    }
  }
  function headerTableStatic(rows) {
    var table = el('table', 'headers');
    var body = el('tbody');
    rows.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', 'name', row[0]));
      tr.appendChild(el('td', '', row[1]));
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  // ---------- actions ----------
  function doReplay(id, button) {
    button.disabled = true;
    api('/api/requests/' + id + '/replay', { method: 'POST', headers: MUTATE, body: '{}' }).then(function (body) {
      toast('Replayed as #' + body.id);
      if (body.id) select(body.id);
    }).catch(function (error) {
      toast('Replay failed: ' + error.message, 5000);
      button.disabled = false;
    });
  }

  // ---------- edit & replay ----------
  // Unchanged bodies are sent as the captured bytes (base64), so CRLF line endings, a BOM or
  // binary data survive; the textarea only becomes the body once the user edits it.
  var ed = null;
  function textOrNull(bytes) {
    var text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (e) { return null; }
    return looksBinary(text) ? null : text;
  }
  function openEditor(d, opener) {
    var req = d.request;
    var raw = bytesFrom64(req.base64);
    var text = textOrNull(raw);
    ed = { id: d.id, opener: opener, base64: req.base64 || '', raw: raw, text: text, encoding: req.contentEncoding || '',
      decoded: req.decodedBase64 || '', partial: !!req.truncated || !req.complete, truncated: req.truncated, bytes: req.bytes,
      mode: text === null ? 'bytes' : 'text', touched: false, converted: '', sending: false };
    $('ed-title').textContent = 'Edit & replay #' + d.id;
    $('ed-sub').textContent = 'Sends a new request straight to ' + (localBase() || 'the local app') + ' (not through the tunnel). Request #' + d.id + ' stays as captured.';
    var methodNote = $('ed-method-note');
    clear(methodNote);
    if (EDIT_METHODS.indexOf(d.method) === -1) {
      $('ed-method').value = 'GET';
      methodNote.appendChild(el('div', 'note warn', 'The captured method ' + d.method + ' cannot be sent from the editor; pick one of ' + EDIT_METHODS.join(', ') + '.'));
    } else $('ed-method').value = d.method;
    $('ed-path').value = d.path;
    $('ed-headers').value = req.headers.filter(function (pair) { return !REGENERATED[pair[0].toLowerCase()]; })
      .map(function (pair) { return pair[0] + ': ' + pair[1]; }).join('\n');
    $('ed-body').value = text === null ? '' : text;
    var crlf = text !== null && text.indexOf('\r\n') !== -1;
    $('ed-eol').hidden = !(text !== null && text.indexOf('\r') !== -1);
    $('ed-eol').value = crlf ? 'crlf' : 'lf';
    $('ed-confirm').checked = false;
    editorError('');
    renderEditorBody();
    $('editor').showModal();
    $('ed-path').focus();
  }
  function renderEditorBody() {
    var notes = $('ed-notes');
    clear(notes);
    var asIs = ed.mode === 'bytes' || !ed.touched;
    if (ed.partial && asIs && ed.raw.length) {
      notes.appendChild(el('div', 'note warn', ed.truncated
        ? 'Partial body: only the first ' + fmtBytes(ed.raw.length) + ' of ' + fmtBytes(ed.bytes) + ' were captured. Confirm below to send it as shown, or replace it.'
        : 'Partial body: the captured body never finished arriving (' + fmtBytes(ed.raw.length) + ' captured). Confirm below to send it as shown, or replace it.'));
    } else if (ed.partial && ed.raw.length && ed.converted !== 'empty') {
      notes.appendChild(el('div', 'note warn', 'This body started from a partial capture; check that it is complete before sending.'));
    }
    if (ed.mode === 'bytes') {
      notes.appendChild(el('div', 'note', 'The captured body is not UTF-8 text' + (ed.encoding ? ' (Content-Encoding: ' + ed.encoding + ')' : '') + '. Its ' + fmtBytes(ed.raw.length) + ' of original bytes are sent unchanged unless you switch to editing it as text.'));
    } else if (ed.converted === 'decoded' || ed.converted === 'lossy') {
      notes.appendChild(el('div', 'note warn', ed.converted === 'decoded'
        ? 'Shown decoded from ' + ed.encoding + '. The text is sent as is, so remove the Content-Encoding header or the app will try to decompress it.'
        : 'Shown as text: bytes that are not valid UTF-8 became U+FFFD. The text below is sent, not the original bytes.'));
    }
    $('ed-body').hidden = ed.mode === 'bytes';
    $('ed-astext').hidden = ed.mode !== 'bytes';
    $('ed-restore').hidden = asIs && ed.mode === (ed.text === null ? 'bytes' : 'text');
    $('ed-confirm-row').hidden = !(ed.partial && asIs && ed.raw.length);
    var size = ed.mode === 'bytes' ? ed.raw.length : new TextEncoder().encode($('ed-body').value).length;
    $('ed-bodyinfo').textContent = fmtBytes(size) + (asIs ? ', as captured' : ', edited');
  }
  function editorError(message) {
    var node = $('ed-error');
    node.textContent = message;
    node.hidden = !message;
  }
  function editorPayload() {
    var pairs = [];
    var lines = $('ed-headers').value.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var colon = lines[i].indexOf(':');
      if (colon <= 0) return { error: 'Header line ' + (i + 1) + ' must look like "name: value".' };
      pairs.push([lines[i].slice(0, colon).trim(), lines[i].slice(colon + 1).trim()]);
    }
    var payload = { replayOf: ed.id, method: $('ed-method').value, path: $('ed-path').value, headers: pairs };
    if (ed.mode === 'bytes' || !ed.touched) {
      if (ed.partial && ed.raw.length && !$('ed-confirm').checked) return { error: 'The body shown is partial. Tick "Send this partial body as shown", or replace or empty the body.', focus: 'ed-confirm' };
      payload.body = ed.base64;
      payload.bodyEncoding = 'base64';
    } else {
      var text = $('ed-body').value;
      if (!$('ed-eol').hidden && $('ed-eol').value === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
      payload.body = text;
      payload.bodyEncoding = 'text';
    }
    return { payload: payload };
  }
  function sendEditor() {
    if (!ed || ed.sending) return;
    var built = editorPayload();
    if (built.error) { editorError(built.error); if (built.focus) $(built.focus).focus(); return; }
    editorError('');
    ed.sending = true;
    $('ed-send').disabled = true;
    var current = ed;
    api('/api/replay', { method: 'POST', headers: MUTATE, body: JSON.stringify(built.payload) }).then(function (body) {
      if (ed === current) $('editor').close();
      toast('Sent edited request as #' + body.id);
      if (body.id) select(body.id);
    }).catch(function (error) {
      if (ed === current) editorError('Not sent: ' + error.message);
    }).then(function () {
      current.sending = false;
      $('ed-send').disabled = false;
    });
  }
  function touchBody() { ed.touched = true; renderEditorBody(); }
  $('ed-body').addEventListener('input', function () { if (ed && !ed.touched) touchBody(); else if (ed) renderEditorBody(); });
  $('ed-eol').addEventListener('change', function () { if (ed) touchBody(); });
  $('ed-confirm').addEventListener('change', function () { if ($('ed-confirm').checked) editorError(''); });
  $('ed-astext').addEventListener('click', function () {
    var decoded = ed.decoded ? textOrNull(bytesFrom64(ed.decoded)) : null;
    ed.converted = decoded !== null ? 'decoded' : 'lossy';
    $('ed-body').value = decoded !== null ? decoded : utf8(ed.raw, false);
    ed.mode = 'text';
    touchBody();
    $('ed-body').focus();
  });
  $('ed-restore').addEventListener('click', function () {
    ed.mode = ed.text === null ? 'bytes' : 'text';
    ed.touched = false;
    ed.converted = '';
    $('ed-body').value = ed.text === null ? '' : ed.text;
    $('ed-eol').value = ed.text !== null && ed.text.indexOf('\r\n') !== -1 ? 'crlf' : 'lf';
    renderEditorBody();
  });
  $('ed-empty').addEventListener('click', function () {
    ed.mode = 'text';
    ed.converted = 'empty';
    $('ed-body').value = '';
    touchBody();
    $('ed-body').focus();
  });
  $('ed-send').addEventListener('click', sendEditor);
  $('ed-cancel').addEventListener('click', function () { $('editor').close(); });
  $('editor').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendEditor(); }
  });
  $('editor').addEventListener('close', function () {
    var opener = ed && ed.opener;
    ed = null;
    // Live updates re-render the detail pane, so the button that opened the editor may be gone.
    var target = opener && opener.isConnected ? opener : $('d-edit');
    if (target) target.focus();
  });

  function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
  function publicBase(d) {
    var url = (status && status.publicUrl) || d.publicUrl;
    return url ? String(url).replace(/\/+$/, '') : '';
  }
  function localBase() { return status && status.target ? status.target : ''; }
  function curlCommand(d, where) {
    var omit = Object.assign({}, CURL_OMIT);
    d.request.headers.forEach(function (pair) {
      if (pair[0].toLowerCase() === 'connection') pair[1].split(',').forEach(function (name) { omit[name.trim().toLowerCase()] = 1; });
    });
    var args = ['curl --globoff --path-as-is', '--request ' + shellQuote(d.method)];
    d.request.headers.forEach(function (pair) {
      if (!omit[pair[0].toLowerCase()]) args.push('--header ' + shellQuote(pair[0] + ': ' + pair[1]));
    });
    args.push('--url ' + shellQuote((where === 'public' ? publicBase(d) : localBase()) + d.path));
    if (d.request.retained) {
      args.push('--data-binary @-');
      return 'printf ' + shellQuote('%s') + ' ' + shellQuote(d.request.base64) + ' | base64 -d | ' + args.join(' \\\n  ');
    }
    return args.join(' \\\n  ');
  }
  function copyCurl(d, where) {
    var command = curlCommand(d, where);
    var warning = 'Copied. The command contains captured header values (for example Authorization or Cookie); treat it as a secret.';
    var fallback = function () {
      var root = $('detail');
      var box = el('div', 'copybox');
      box.appendChild(el('div', 'note warn', 'Clipboard access is unavailable. Copy the command below; it may contain secrets.'));
      var area = el('textarea');
      area.value = command;
      area.readOnly = true;
      box.appendChild(area);
      root.appendChild(box);
      area.focus();
      area.select();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(command).then(function () { toast(warning, 5000); }, fallback);
    } else fallback();
  }
  $('clear').addEventListener('click', function () {
    api('/api/requests', { method: 'DELETE', headers: MUTATE, body: '{}' }).catch(function (error) { toast('Clear failed: ' + error.message); });
  });

  // ---------- data ----------
  function loadStatus() {
    return api('/api/status').then(function (body) {
      status = body;
      var meta = $('meta');
      clear(meta);
      meta.appendChild(el('b', '', body.publicUrl || 'Tunnel not connected'));
      meta.appendChild(document.createTextNode(' → ' + body.target));
      var stats = body.inspector || {};
      $('stats').textContent = (stats.entries || 0) + ' / ' + stats.maxEntries + ' entries · ' + fmtBytes(stats.bytes || 0) + ' of ' + fmtBytes(stats.maxBytes) + ' memory';
    }).catch(function () { });
  }
  function loadAll() {
    return api('/api/requests').then(function (body) {
      entries.clear();
      body.entries.forEach(function (entry) { entries.set(entry.id, entry); });
      if (selected !== null && !entries.has(selected)) { selected = null; detail = null; renderMissing(); }
      queueRender();
      if (selected !== null) loadDetail();
    }).catch(function () { });
  }
  function scheduleStatus() {
    if (scheduleStatus.timer) return;
    scheduleStatus.timer = setTimeout(function () { scheduleStatus.timer = null; loadStatus(); }, 1000);
  }
  function upsert(entry) {
    var isNew = !entries.has(entry.id);
    entries.set(entry.id, entry);
    if (isNew || entry.done) scheduleStatus();
    queueRender();
    if (entry.id === selected) scheduleDetail();
    if (detail && detail.replays && detail.replays.indexOf(entry.id) !== -1 && entry.id !== selected) scheduleDetail();
  }
  function connect() {
    var source = new EventSource('/api/events');
    source.addEventListener('open', function () {
      $('conn').textContent = 'Live';
      $('conn').className = 'conn live';
      loadAll();
      loadStatus();
    });
    source.addEventListener('error', function () {
      $('conn').textContent = 'Reconnecting…';
      $('conn').className = 'conn';
    });
    source.addEventListener('created', function (event) { upsert(JSON.parse(event.data)); });
    source.addEventListener('updated', function (event) { upsert(JSON.parse(event.data)); });
    source.addEventListener('evicted', function (event) {
      JSON.parse(event.data).ids.forEach(function (id) { entries.delete(id); });
      scheduleStatus();
      if (selected !== null && !entries.has(selected)) { selected = null; detail = null; renderMissing('That request was evicted to stay within the memory limit.'); }
      queueRender();
    });
    source.addEventListener('cleared', function () {
      entries.clear();
      selected = null;
      detail = null;
      renderMissing();
      queueRender();
      loadStatus();
    });
  }
  setInterval(loadStatus, 10000);
  connect();
})();
</script>
</body>
</html>
`
}
