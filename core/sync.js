// PhoneDrop's sync engine: watches this computer's clipboard, sends new text
// and images to the hub encrypted, sends files on request (to every device or
// one), keeps track of which of your devices are online, and applies what your
// other devices send.
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { deriveSecrets, seal, unseal, sealBytes, unsealBytes, newId } from '../shared/crypto.js';
import { connectPreferred, httpBase } from '../shared/connect.js';

const POLL_MS = 600;
const PROBE_MS = 30_000; // how often to check whether home Wi-Fi is back while on Tailscale
const MAX_CHARS = 500_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024; // matches the hub's limit
const RECENT_LIMIT = 10;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
};

function openWs(url) {
  const ws = new WebSocket(url);
  // The hub greets us the instant the socket opens, often before we've chosen
  // between Wi-Fi and Tailscale; hold those messages until the socket is adopted.
  ws.early = [];
  const hold = (data) => ws.early.push(data);
  ws.on('message', hold);
  ws.release = () => ws.off('message', hold);
  const promise = new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('closed')));
  });
  return { promise, abort: () => ws.terminate() };
}

const viaOf = (url, tier) => (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? 'local' : tier > 0 ? 'tailscale' : 'wifi');

// Clipboard readers may return a string, { kind: 'text', text },
// { kind: 'image', fingerprint, getPng }, or nothing.
const normalize = (item) => (typeof item === 'string' ? (item ? { kind: 'text', text: item } : null) : item || null);
const keyOf = (item) => (!item ? '' : item.kind === 'text' ? `t:${item.text}` : `i:${item.fingerprint}`);

// candidates(): [{ url: 'ws://host:port/ws', tier }], re-read on every reconnect.
// writeClipboard(item): item is { kind: 'text', text } or { kind: 'image', png }.
// saveFile({ name, bytes, from }): stores a received file, returns its path.
// deviceId: stable random id for this device; kind: 'mac' | 'pc' (shown as its bubble).
// onEvent(event, state): status | sent | received | received-file | skipped | recent | devices | endpoints | error
export async function startSync({ candidates, passphrase, device, deviceId, kind, readClipboard, writeClipboard, saveFile, onEvent = () => {}, probeMs = PROBE_MS }) {
  const { key, room } = await deriveSecrets(passphrase);
  const read = async (opts) => {
    try {
      return normalize(await readClipboard(opts));
    } catch {
      return null; // clipboard busy or unreadable
    }
  };

  // status: 'connecting' | 'connected' | 'disconnected'; via: 'wifi' | 'tailscale' | 'local'
  // devices: your other devices online right now, conn -> { id, name, kind }
  const state = { status: 'connecting', via: null, tier: null, server: null, paused: false, recent: [], retryIn: 0, endpoints: null, devices: new Map() };
  const emit = (event) => onEvent(event, state);
  const sentIds = new Set();
  const handled = new Set();
  const localData = new Map(); // images we sent, so Recent doesn't download them again
  let lastKey = keyOf(await read({ fresh: true })); // don't broadcast whatever was copied before startup
  let socket = null;
  let pending = null;
  let retry = 0;
  let stopped = false;
  let pollTimer;
  let retryTimer;
  let probeTimer;

  const connected = () => socket?.readyState === WebSocket.OPEN;

  function setStatus(status) {
    state.status = status;
    emit({ type: 'status' });
  }

  function remember(clip) {
    if (state.recent.some((c) => c.id === clip.id)) return;
    if (localData.has(clip.id)) clip.data = localData.get(clip.id);
    state.recent.unshift(clip);
    state.recent.sort((a, b) => b.ts - a.ts);
    state.recent.length = Math.min(state.recent.length, RECENT_LIMIT);
  }

  // --- Files on the hub ----------------------------------------------------

  async function upload(bytes) {
    const blobId = newId();
    const res = await fetch(`${httpBase(state.server)}/blob/${room}/${blobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await sealBytes(key, bytes),
    });
    if (!res.ok) throw new Error(res.status === 413 ? 'File is too large' : `Upload failed (${res.status})`);
    return blobId;
  }

  async function download(blobId) {
    const res = await fetch(`${httpBase(state.server)}/blob/${room}/${blobId}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'That file is no longer on the hub' : `Download failed (${res.status})`);
    return Buffer.from(await unsealBytes(key, await res.arrayBuffer()));
  }

  // --- Sending ---------------------------------------------------------------

  async function sendClip(payload, blobId) {
    const id = newId();
    if (sentIds.size > 1000) sentIds.clear();
    sentIds.add(id);
    const msg = { type: 'clip', id, ...(await seal(key, { ...payload, from: device, fromId: deviceId })) };
    if (blobId) msg.blob = blobId;
    socket.send(JSON.stringify(msg));
    emit({ type: 'sent', clip: payload });
    return id;
  }

  async function sendImage(png) {
    if (png.length > MAX_IMAGE_BYTES) {
      emit({ type: 'skipped', reason: `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` });
      return;
    }
    const blobId = await upload(png);
    const id = await sendClip({ kind: 'image', name: 'Image.png', mime: 'image/png', size: png.length }, blobId);
    localData.set(id, png);
    if (localData.size > RECENT_LIMIT) localData.delete(localData.keys().next().value);
  }

  // Sends now, or as soon as we're connected again (only the latest copy waits).
  function sendOrQueue(job) {
    const run = () => job().catch((err) => emit({ type: 'error', message: err.message }));
    if (connected()) run();
    else pending = run;
  }

  async function poll() {
    if (stopped) return;
    const item = await read();
    const itemKey = keyOf(item);
    if (item && itemKey !== lastKey) {
      lastKey = itemKey; // copies made while paused are skipped, not queued
      if (state.paused) {
        // nothing to do
      } else if (item.kind === 'text') {
        if (item.text.length > MAX_CHARS) emit({ type: 'skipped', reason: `Text is longer than ${MAX_CHARS} characters` });
        else sendOrQueue(() => sendClip({ kind: 'text', text: item.text }));
      } else if (item.kind === 'image') {
        const png = item.getPng();
        sendOrQueue(() => sendImage(png));
      }
    }
    pollTimer = setTimeout(poll, POLL_MS);
  }

  // --- Receiving ---------------------------------------------------------------

  async function applyLive(clip) {
    if (clip.kind === 'text') {
      await writeClipboard({ kind: 'text', text: clip.text });
    } else if (clip.kind === 'image') {
      clip.data = await download(clip.blob);
      await writeClipboard({ kind: 'image', png: clip.data });
    } else if (clip.kind === 'file') {
      clip.savedPath = await saveFile({ name: clip.name, bytes: await download(clip.blob), from: clip.from });
      emit({ type: 'received-file', clip });
      return;
    }
    // Remember what the clipboard now holds, so we don't send it straight back.
    lastKey = keyOf(await read({ fresh: true }));
    emit({ type: 'received', clip });
  }

  async function onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'presence') {
      try {
        const info = await unseal(key, msg);
        if (info.id !== deviceId) state.devices.set(msg.conn, { id: info.id, name: info.name, kind: info.kind });
      } catch {}
      emit({ type: 'devices' });
      return;
    }
    if (msg.type === 'gone') {
      state.devices.delete(msg.conn);
      emit({ type: 'devices' });
      return;
    }
    if (msg.type === 'history' && msg.endpoints) {
      state.endpoints = msg.endpoints;
      emit({ type: 'endpoints' });
    }
    const items = msg.type === 'history' ? msg.items : msg.type === 'clip' ? [msg] : [];
    for (const item of items) {
      let clip;
      try {
        const payload = await unseal(key, item);
        clip = { kind: 'text', ...payload, id: item.id, ts: item.ts, blob: item.blob };
      } catch {
        continue;
      }
      if (clip.to && clip.to !== deviceId && !sentIds.has(item.id)) continue; // sent to another device
      remember(clip);
      // Only live clips from other devices are applied; never the history
      // replayed on connect, so reconnecting can't clobber the clipboard.
      if (msg.type === 'clip' && !sentIds.has(item.id) && !handled.has(item.id) && !state.paused) {
        handled.add(item.id);
        try {
          await applyLive(clip);
        } catch (err) {
          emit({ type: 'error', message: err.message });
        }
      }
    }
    emit({ type: 'recent' });
  }

  // --- Connection: prefer home Wi-Fi, fall back to Tailscale -------------------

  const withRoom = (list) => list.map((c) => ({ ...c, url: `${c.url}?room=${room}` }));

  function adopt({ socket: ws, url, tier }) {
    const previous = socket;
    socket = ws;
    state.server = url.split('?')[0];
    state.tier = tier;
    state.via = viaOf(url, tier);
    retry = 0;
    ws.release();
    ws.on('message', onMessage);
    for (const data of ws.early.splice(0)) onMessage(data);
    ws.on('error', () => {}); // 'close' follows and handles the retry
    ws.on('close', () => {
      if (ws !== socket || stopped) return;
      state.retryIn = Math.min(30_000, 1000 * 2 ** retry++);
      setStatus('disconnected');
      retryTimer = setTimeout(connect, state.retryIn);
    });
    if (previous && previous !== ws) previous.close();
    state.devices.clear(); // the new connection hears everyone's announcement again
    seal(key, { id: deviceId, name: device, kind }).then((sealed) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', ...sealed }));
    });
    setStatus('connected');
    if (pending) {
      const job = pending;
      pending = null;
      job();
    }
    scheduleProbe();
  }

  async function connect() {
    if (stopped) return;
    if (state.status !== 'disconnected') setStatus('connecting');
    try {
      const result = await connectPreferred(withRoom(candidates()), openWs);
      if (stopped) result.socket.close();
      else adopt(result);
    } catch {
      state.retryIn = Math.min(30_000, 1000 * 2 ** retry++);
      setStatus('disconnected');
      retryTimer = setTimeout(connect, state.retryIn);
    }
  }

  function scheduleProbe() {
    clearTimeout(probeTimer);
    if (!state.tier) return; // already on the best path
    probeTimer = setTimeout(async () => {
      const better = candidates().filter((c) => c.tier < state.tier);
      if (better.length && connected()) {
        try {
          const result = await connectPreferred(withRoom(better), openWs, { timeoutMs: 4000 });
          if (!stopped && connected()) return adopt(result);
          result.socket.close();
        } catch {}
      }
      if (!stopped) scheduleProbe();
    }, probeMs);
  }

  connect();
  poll();

  return {
    state,
    setPaused(paused) {
      state.paused = paused;
      emit({ type: 'status' });
    },
    // to: a device id from state.devices, or nothing for all your devices.
    async sendFile(filePath, { to } = {}) {
      if (!connected()) throw new Error("Not connected to the hub");
      const { size } = await fs.stat(filePath);
      if (size > MAX_FILE_BYTES) throw new Error(`${path.basename(filePath)} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const bytes = await fs.readFile(filePath);
      const blobId = await upload(bytes);
      const name = path.basename(filePath);
      await sendClip({ kind: 'file', name, mime: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', size, ...(to ? { to } : {}) }, blobId);
    },
    // The bytes behind an image or file clip, for "copy again" / "save" from Recent.
    async getData(clip) {
      const data = clip.data || await download(clip.blob);
      if (clip.kind === 'image') clip.data = data; // files can be big; don't keep them in memory
      return data;
    },
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(retryTimer);
      clearTimeout(probeTimer);
      socket?.close();
    },
  };
}
