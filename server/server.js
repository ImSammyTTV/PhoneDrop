// PhoneDrop hub: runs inside the app on one computer, serves the phone web app
// and relays encrypted clips, files and device announcements between your
// devices. It only ever sees ciphertext, and it only talks to devices on your
// home network or tailnet.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ensureCerts } from './certs.js';
import { isAllowedAddress, isLoopback, lanAddresses, localHostname, tailscaleAddresses } from './network.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const HISTORY_LIMIT = 25;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_STORED_BYTES = 1024 * 1024 * 1024; // per passphrase; oldest files are dropped first
const ORPHAN_AGE_MS = 10 * 60 * 1000; // uploads never announced as a clip

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// The phone may load the app from one address and reach the hub through
// another (Wi-Fi vs Tailscale), so file transfers and the address list allow
// any origin. The passphrase-derived room id is what grants access.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function startHub({
  port = 47615,
  httpsPort = port + 1,
  certDir = path.join(ROOT, 'certs'),
  blobDir = path.join(os.tmpdir(), `phonedrop-files-${port}`),
} = {}) {
  const tls = ensureCerts(certDir);
  const host = localHostname();
  // Files only live as long as the hub; start clean.
  fs.rmSync(blobDir, { recursive: true, force: true });
  fs.mkdirSync(blobDir, { recursive: true });

  // How devices can reach this hub: at home over Wi-Fi, away over Tailscale.
  const endpoints = () => ({
    lan: [`http://${host}:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)],
    tailscale: tailscaleAddresses().map((ip) => `http://${ip}:${port}`),
    httpsPort,
  });

  function resolveStatic(urlPath) {
    if (/^\/shared\/[a-z]+\.js$/.test(urlPath)) return path.join(ROOT, urlPath);
    if (urlPath === '/ca.crt') return path.join(certDir, 'ca.pem');
    const file = path.normalize(path.join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath));
    return file.startsWith(WEB_DIR + path.sep) ? file : null;
  }

  // --- Rooms and clip history ----------------------------------------------

  // roomId -> { clients: Set<WebSocket>, history: clip[] }
  const rooms = new Map();
  // "room/blobId" -> { size, uploadedAt }
  const blobs = new Map();

  function getRoom(id) {
    let room = rooms.get(id);
    if (!room) rooms.set(id, (room = { clients: new Set(), history: [] }));
    return room;
  }

  const blobPath = (roomId, blobId) => path.join(blobDir, roomId, blobId);

  function deleteBlob(roomId, blobId) {
    blobs.delete(`${roomId}/${blobId}`);
    fs.rm(blobPath(roomId, blobId), { force: true }, () => {});
  }

  function addToHistory(roomId, room, clip) {
    room.history.push(clip);
    const drop = (index) => {
      const [old] = room.history.splice(index, 1);
      if (old.blob) deleteBlob(roomId, old.blob);
    };
    if (room.history.length > HISTORY_LIMIT) drop(0);
    // Keep stored files under the cap by dropping the oldest ones.
    const stored = () => room.history.reduce((sum, c) => sum + (c.blob ? blobs.get(`${roomId}/${c.blob}`)?.size || 0 : 0), 0);
    while (stored() > MAX_STORED_BYTES) {
      const oldest = room.history.findIndex((c) => c.blob && c !== clip);
      if (oldest < 0) break;
      drop(oldest);
    }
  }

  // --- HTTP: web app, setup, address list, files ---------------------------

  async function handleBlob(req, res, roomId, blobId) {
    const file = blobPath(roomId, blobId);
    if (req.method === 'GET') {
      fs.stat(file, (err, stat) => {
        if (err) {
          res.writeHead(404, CORS).end();
          return;
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
        fs.createReadStream(file).pipe(res);
      });
      return;
    }
    if (req.method !== 'PUT') {
      res.writeHead(405, CORS).end();
      return;
    }
    if (blobs.has(`${roomId}/${blobId}`)) {
      res.writeHead(409, CORS).end();
      return;
    }
    // Encrypted files are a little bigger than the original: 12-byte IV + 16-byte tag.
    const limit = MAX_FILE_BYTES + 64;
    if (Number(req.headers['content-length']) > limit) {
      res.writeHead(413, CORS).end('File too large');
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.part`;
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        done(size > limit ? new Error('too large') : null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(partial));
      fs.renameSync(partial, file);
      blobs.set(`${roomId}/${blobId}`, { size, uploadedAt: Date.now() });
      res.writeHead(201, CORS).end();
    } catch {
      fs.rm(partial, { force: true }, () => {});
      if (!res.headersSent) res.writeHead(size > limit ? 413 : 400, CORS).end();
    }
  }

  async function handleRequest(req, res) {
    const remote = req.socket.remoteAddress;
    if (!isAllowedAddress(remote)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('PhoneDrop only accepts your own devices (home network or Tailscale)');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (pathname === '/healthz') {
      res.end('ok');
      return;
    }
    if (pathname === '/endpoints.json') {
      res.writeHead(200, { ...CORS, 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(endpoints()));
      return;
    }
    const blob = pathname.match(/^\/blob\/([a-f0-9]{64})\/([a-f0-9]{24})$/);
    if (blob) {
      handleBlob(req, res, blob[1], blob[2]);
      return;
    }
    // Phones need HTTPS for the app, so plain-HTTP visitors get the setup guide.
    if (pathname === '/' && !req.socket.encrypted && !isLoopback(remote)) pathname = '/setup.html';

    const file = resolveStatic(pathname);
    try {
      if (!file) throw new Error('outside web root');
      let body = await readFile(file);
      if (pathname === '/setup.html') body = body.toString().replaceAll('{{HTTPS_PORT}}', String(httpsPort));
      const type = pathname === '/ca.crt' ? 'application/x-x509-ca-cert' : TYPES[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  // --- WebSocket relay ------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws, req) => {
    const roomId = new URL(req.url, 'http://localhost').searchParams.get('room') || '';
    if (!/^[a-f0-9]{64}$/.test(roomId)) {
      ws.close(1008, 'invalid room');
      return;
    }
    const room = getRoom(roomId);
    room.clients.add(ws);
    ws.isAlive = true;
    ws.conn = crypto.randomBytes(8).toString('hex');
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'history', items: room.history, endpoints: endpoints() }));
    // Tell the newcomer who else is here (each device's own encrypted announcement).
    for (const peer of room.clients) if (peer.presence) ws.send(peer.presence);

    const broadcast = (out, { except } = {}) => {
      for (const peer of room.clients) {
        if (peer !== except && peer.readyState === peer.OPEN) peer.send(out);
      }
    };

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (![msg.iv, msg.ct].every((v) => typeof v === 'string')) return;

      // A device announcing itself (name and type, encrypted): passed on, never stored.
      if (msg.type === 'presence' && msg.ct.length < 4096) {
        ws.presence = JSON.stringify({ type: 'presence', conn: ws.conn, iv: msg.iv, ct: msg.ct });
        broadcast(ws.presence, { except: ws });
        return;
      }
      if (msg.type !== 'clip' || typeof msg.id !== 'string') return;

      const clip = { type: 'clip', id: msg.id.slice(0, 64), iv: msg.iv, ct: msg.ct, ts: Date.now() };
      // A file or image clip points at an uploaded file; only accept ones we have.
      if (msg.blob !== undefined) {
        if (typeof msg.blob !== 'string' || !blobs.has(`${roomId}/${msg.blob}`)) return;
        clip.blob = msg.blob;
      }
      addToHistory(roomId, room, clip);

      // Echo to the sender too: it doubles as a delivery receipt.
      broadcast(JSON.stringify(clip));
    });

    ws.on('close', () => {
      room.clients.delete(ws);
      if (ws.presence) broadcast(JSON.stringify({ type: 'gone', conn: ws.conn }));
      if (!room.clients.size && !room.history.length) rooms.delete(roomId);
    });
  });

  function handleUpgrade(req, socket, head) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws' || !isAllowedAddress(req.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  // Drop dead connections (e.g. a phone that went to sleep) and abandoned uploads.
  const housekeeping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    const referenced = new Set([...rooms].flatMap(([id, r]) => r.history.filter((c) => c.blob).map((c) => `${id}/${c.blob}`)));
    for (const [key, info] of blobs) {
      if (!referenced.has(key) && Date.now() - info.uploadedAt > ORPHAN_AGE_MS) deleteBlob(...key.split('/'));
    }
  }, 30_000);
  housekeeping.unref();

  const httpServer = http.createServer(handleRequest);
  const httpsServer = https.createServer(tls, handleRequest);
  for (const server of [httpServer, httpsServer]) server.on('upgrade', handleUpgrade);
  try {
    await listen(httpServer, port);
    await listen(httpsServer, httpsPort);
  } catch (err) {
    httpServer.close();
    httpsServer.close();
    clearInterval(housekeeping);
    throw err;
  }

  return {
    host,
    ips: lanAddresses(),
    tailscaleIps: tailscaleAddresses(),
    computerUrl: `http://${host}:${port}`,
    phoneSetupUrl: `http://${host}:${port}`,
    phoneAppUrl: `https://${host}:${httpsPort}`,
    // Resolves once both ports are free again, so the hub can restart straight away.
    close() {
      clearInterval(housekeeping);
      for (const ws of wss.clients) ws.terminate();
      fs.rmSync(blobDir, { recursive: true, force: true });
      return Promise.all([httpServer, httpsServer].map((server) => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })));
    },
  };
}

