import { deriveSecrets, seal, unseal, sealBytes, unsealBytes, newId } from '/shared/crypto.js';
import { connectPreferred, hubCandidates, httpBase } from '/shared/connect.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // matches the hub's limit
const AUTO_LOAD_BYTES = 8 * 1024 * 1024; // smaller files are fetched as soon as they arrive
const PROBE_MS = 30_000; // how often to check for home Wi-Fi while on Tailscale

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  clear() { try { localStorage.clear(); } catch {} },
};

// iPadOS Safari pretends to be a Mac, so look for touch support too
const ua = navigator.userAgent;
const KIND = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ipad' : /Android/.test(ua) ? 'android' : 'iphone';
const DEFAULT_NAME = { ipad: 'iPad', android: 'Android phone', iphone: 'iPhone' }[KIND];
let me = store.get('pd-id');
if (!me) {
  me = newId();
  store.set('pd-id', me);
}

const PHONE = '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>';
const TABLET = '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M11 18h2"/></svg>';
const LAPTOP = '<svg viewBox="0 0 24 24"><rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 18.5h19"/></svg>';
const DESKTOP = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICONS = { iphone: PHONE, android: PHONE, ipad: TABLET, mac: LAPTOP, pc: DESKTOP };

const clips = new Map(); // id -> { kind, text | name/mime/size/blob, from, ts, data?, url? }
const devices = new Map(); // conn -> { id, name, kind }
const localBlobs = new Map(); // things we sent, so we don't download them again
const outbox = [];
let key, room, socket, tier, base, reconnectTimer, probeTimer, target;
let connecting = false;
let retry = 0;

const device = () => store.get('device') || DEFAULT_NAME;

function setStatus(text, online = false) {
  $('status').textContent = text;
  $('status').classList.toggle('online', online);
}

let toastTimer;
function toast(text, onTap) {
  const el = $('toast');
  el.textContent = text;
  el.onclick = onTap ? () => { onTap(); el.classList.remove('show'); } : null;
  el.classList.toggle('tappable', !!onTap);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), onTap ? 8000 : 2200);
}

const mb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

// --- Reaching the hub: home Wi-Fi first, Tailscale when away -----------------

function endpoints() {
  try {
    return JSON.parse(store.get('endpoints'));
  } catch {
    return null;
  }
}

function saveEndpoints(value) {
  if (value) store.set('endpoints', JSON.stringify(value));
}

// Learn the hub's addresses (including Tailscale) while we can reach it at home.
async function refreshEndpoints() {
  try {
    const res = await fetch('/endpoints.json', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (res.ok) saveEndpoints(await res.json());
  } catch {
    // Away from home: use what we learned last time.
  }
}

const candidates = () => hubCandidates(endpoints(), { secure: location.protocol === 'https:', extra: [location.origin] })
  .map((c) => ({ ...c, url: `${c.url}?room=${room}` }));

function openWs(url) {
  const ws = new WebSocket(url);
  // The hub greets us the instant the socket opens; keep that until we pick this socket.
  ws.early = [];
  const hold = (e) => ws.early.push(e.data);
  ws.addEventListener('message', hold);
  ws.release = () => ws.removeEventListener('message', hold);
  const promise = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
    ws.addEventListener('close', reject, { once: true });
  });
  return { promise, abort: () => ws.close() };
}

async function adopt({ socket: ws, url, tier: newTier }) {
  const previous = socket;
  socket = ws;
  tier = newTier;
  base = httpBase(url.split('?')[0]);
  retry = 0;
  devices.clear(); // the new connection hears everyone's announcement again
  ws.release();
  ws.onmessage = (e) => onMessage(e.data);
  for (const data of ws.early.splice(0)) onMessage(data);
  ws.onclose = () => {
    if (ws !== socket) return;
    devices.clear();
    renderDevices();
    setStatus('Reconnecting…');
    scheduleReconnect();
  };
  if (previous && previous !== ws) previous.close();
  ws.send(JSON.stringify({ type: 'presence', ...(await seal(key, { id: me, name: device(), kind: KIND })) }));
  setStatus(`Connected · ${tier ? 'Tailscale' : 'Wi-Fi'}`, true);
  outbox.splice(0).forEach((m) => socket.send(m));
  renderDevices();
  scheduleProbe();
}

async function connect() {
  if (connecting) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  setStatus('Connecting…');
  try {
    await adopt(await connectPreferred(candidates(), openWs));
  } catch {
    setStatus("Can't reach your computer");
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
}

// While on Tailscale, keep checking whether home Wi-Fi is reachable again.
function scheduleProbe(delay = PROBE_MS) {
  clearTimeout(probeTimer);
  if (!tier) return;
  probeTimer = setTimeout(async () => {
    const better = candidates().filter((c) => c.tier < tier);
    if (better.length && document.visibilityState === 'visible' && socket?.readyState === WebSocket.OPEN) {
      try {
        const result = await connectPreferred(better, openWs, { timeoutMs: 4000 });
        if (socket?.readyState === WebSocket.OPEN) return adopt(result);
        result.socket.close();
      } catch {}
    }
    scheduleProbe();
  }, delay);
}

// --- Receiving ---------------------------------------------------------------

const connected = () => socket?.readyState === WebSocket.OPEN;

async function onMessage(data) {
  const msg = JSON.parse(data);
  if (msg.type === 'presence') {
    try {
      const info = await unseal(key, msg);
      if (info.id !== me) devices.set(msg.conn, info);
    } catch {}
    return renderDevices();
  }
  if (msg.type === 'gone') {
    devices.delete(msg.conn);
    return renderDevices();
  }
  if (msg.type === 'history') saveEndpoints(msg.endpoints);
  const items = msg.type === 'history' ? msg.items : msg.type === 'clip' ? [msg] : [];
  for (const item of items) await receive(item, msg.type === 'clip');
  render();
}

async function receive(item, live) {
  if (clips.has(item.id)) return;
  let clip;
  try {
    clip = { kind: 'text', ...(await unseal(key, item)), id: item.id, ts: item.ts, blob: item.blob };
  } catch {
    return; // not decryptable with our key
  }
  const mine = clip.fromId === me;
  if (clip.to && clip.to !== me && !mine) return; // sent to another device
  const local = localBlobs.get(item.id);
  if (local) setData(clip, local);
  clips.set(item.id, clip);
  if (clip.kind !== 'text' && !clip.data && clip.size <= AUTO_LOAD_BYTES) load(clip).catch(() => {});
  if (!live || mine) return;
  // Phones only allow clipboard writes and saving from a tap, so offer one.
  if (clip.kind === 'text') toast(`New from ${clip.from}. Tap to copy`, () => copyText(clip.text));
  else if (clip.kind === 'image') toast(`Image from ${clip.from}. Tap to copy`, () => activate(clip));
  else toast(`${clip.name} from ${clip.from}. Tap to save`, () => activate(clip));
}

function setData(clip, blob) {
  clip.data = blob;
  if (clip.kind === 'image' || clip.mime?.startsWith('image/')) clip.url = URL.createObjectURL(blob);
}

function load(clip) {
  if (clip.data) return Promise.resolve();
  clip.loading ??= (async () => {
    const res = await fetch(`${base}/blob/${room}/${clip.blob}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'That file is no longer available' : 'Download failed');
    const bytes = await unsealBytes(key, await res.arrayBuffer());
    setData(clip, new Blob([bytes], { type: clip.mime || 'application/octet-stream' }));
  })().finally(() => {
    clip.loading = null;
    render();
  });
  render();
  return clip.loading;
}

// Tapping a clip: copy text or images; save files (and images, via their Save button).
async function activate(clip, action = clip.kind === 'image' ? 'copy' : 'save') {
  if (clip.kind === 'text') return copyText(clip.text);
  if (!clip.data) {
    try {
      await load(clip);
      toast(`Ready. Tap again to ${action}`);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (action === 'copy') copyImage(clip);
  else saveClip(clip);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

async function copyImage(clip) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [clip.data.type || 'image/png']: clip.data })]);
    toast('Image copied');
  } catch {
    toast("Couldn't copy this image. Use Save instead");
  }
}

// iPhone/iPad: opens the share sheet (Save Image / Save to Files). Elsewhere: downloads.
function saveClip(clip) {
  const file = new File([clip.data], clip.name || 'Image.png', { type: clip.data.type });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// --- Sending ---------------------------------------------------------------------

async function sendText(text) {
  if (!text.trim()) return;
  const msg = JSON.stringify({ type: 'clip', id: newId(), ...(await seal(key, { kind: 'text', text, from: device(), fromId: me })) });
  if (connected()) socket.send(msg);
  else outbox.push(msg);
  toast('Sent to your devices');
}

// Encrypts and uploads with a progress bar (like PhoneDrop 1), then announces it.
async function sendBytes(kind, blob, name, to = null) {
  if (blob.size > MAX_FILE_BYTES) return toast(`${name} is larger than 100 MB`);
  if (!connected()) return toast("Not connected to your computer. Try again in a moment");
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<div class="top"><img class="th"><div class="name"></div></div><div class="bar"><i></i></div>';
  const nm = row.querySelector('.name');
  nm.textContent = name;
  const th = row.querySelector('.th');
  if (blob.type.startsWith('image/')) th.src = URL.createObjectURL(blob);
  else th.remove();
  $('uph').hidden = false;
  $('uploads').prepend(row);
  try {
    const blobId = newId();
    const body = await sealBytes(key, new Uint8Array(await blob.arrayBuffer()));
    await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `${base}/blob/${room}/${blobId}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (p) => { row.querySelector('i').style.width = `${(p.loaded / p.total) * 100}%`; };
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error()));
      x.onerror = reject;
      x.send(body);
    });
    const id = newId();
    const meta = { kind, name, mime: blob.type || 'application/octet-stream', size: blob.size, from: device(), fromId: me, ...(to ? { to } : {}) };
    localBlobs.set(id, blob);
    socket.send(JSON.stringify({ type: 'clip', id, ...(await seal(key, meta)), blob: blobId }));
    row.classList.add('done');
    row.querySelector('i').style.width = '100%';
    nm.textContent = `✓ ${name}`;
  } catch {
    nm.textContent = `✗ Failed: ${name}`;
  }
}

async function sendClipboard() {
  try {
    if (navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (imageType) return sendBytes('image', await item.getType(imageType), 'Image.png');
        if (item.types.includes('text/plain')) return sendText(await (await item.getType('text/plain')).text());
      }
      return toast('Your clipboard is empty');
    }
    const text = await navigator.clipboard.readText();
    if (!text) return toast('Your clipboard is empty');
    await sendText(text);
  } catch {
    toast("Couldn't read the clipboard. Paste into the box instead");
    $('text').focus();
  }
}

// --- Display -----------------------------------------------------------------------

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});

// Your other devices, as bubbles. Tap one to send it files.
function renderDevices() {
  const list = [...new Map([...devices.values()].map((d) => [d.id, d])).values()];
  $('off').hidden = list.length > 0;
  $('off').textContent = connected() ? 'None of your other devices are online' : 'Looking for your computers…';
  $('devs').replaceChildren(...list.map((d) => {
    const b = el('button', 'pc');
    b.innerHTML = `<div class="bubble">${ICONS[d.kind] || DESKTOP}</div><b></b><small>Tap to send files</small>`;
    b.querySelector('b').textContent = d.name;
    b.onclick = () => {
      target = d.id;
      $('f').click();
    };
    return b;
  }));
}

function renderClip(clip) {
  const row = el('div', 'row');
  const who = clip.fromId === me ? 'You' : clip.from;
  if (clip.kind === 'text') {
    row.append(el('div', 'clip-text', clip.text));
  } else {
    if (clip.url && clip.kind === 'image') {
      const img = el('img', 'preview');
      img.src = clip.url;
      row.append(img);
    }
    const top = el('div', 'top');
    if (clip.url && clip.kind !== 'image') {
      const th = el('img', 'th');
      th.src = clip.url;
      top.append(th);
    }
    const hint = clip.loading ? 'Loading…' : clip.data ? (clip.kind === 'image' ? 'Tap to copy' : 'Tap to save') : 'Tap to download';
    const label = el('div');
    label.append(el('div', 'name', clip.kind === 'image' ? 'Image' : clip.name), el('div', 'meta', `${mb(clip.size)} · ${hint}`));
    top.append(label);
    if (clip.kind === 'image' && clip.data) {
      const save = el('button', 'save', 'Save');
      save.onclick = (e) => {
        e.stopPropagation();
        saveClip(clip);
      };
      top.append(save);
    }
    row.append(top);
  }
  row.append(el('div', 'meta', `${who} · ${timeAgo(clip.ts)}`));
  row.onclick = () => activate(clip);
  return row;
}

function render() {
  const items = [...clips.values()].sort((a, b) => b.ts - a.ts);
  $('clips').replaceChildren(...items.map(renderClip));
  $('recenth').hidden = !items.length;
}

// --- Startup ---------------------------------------------------------------------

async function start(passphrase) {
  setStatus('Unlocking…');
  ({ key, room } = await deriveSecrets(passphrase));
  $('setup').hidden = true;
  $('app').hidden = false;
  renderDevices();
  await refreshEndpoints();
  connect();
}

$('device').value = DEFAULT_NAME;
$('setup-form').onsubmit = (e) => {
  e.preventDefault();
  store.set('passphrase', $('passphrase').value);
  store.set('device', $('device').value.trim() || DEFAULT_NAME);
  start($('passphrase').value);
};

$('send-clipboard').onclick = sendClipboard;
$('f').onchange = async () => {
  for (const file of [...$('f').files]) await sendBytes('file', file, file.name, target);
  $('f').value = '';
};

$('compose').onsubmit = async (e) => {
  e.preventDefault();
  await sendText($('text').value);
  $('text').value = '';
};

$('forget').onclick = () => {
  store.clear();
  location.reload();
};

// Phones suspend sockets in the background; reconnect (preferring Wi-Fi) on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !room) return;
  if (!connected()) {
    retry = 0;
    connect();
  } else if (tier) {
    scheduleProbe(0);
  }
  render();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const saved = store.get('passphrase');
if (!window.isSecureContext) {
  // Browsers only allow encryption and clipboard access on HTTPS pages.
  location.replace(`${location.origin}/setup.html`);
} else if (saved) start(saved);
else $('setup').hidden = false;
