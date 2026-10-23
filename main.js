// PhoneDrop: an AirDrop-style tray app for Mac and Windows. Send files between
// your iPhone, iPad and computers, keep the clipboard in sync (text and images),
// and keep working away from home over Tailscale. One computer runs the hub the
// other devices connect to; everything is end-to-end encrypted.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { startHub } from './server/server.js';
import { computerName, lanAddresses, localHostname, tailscaleAddresses } from './server/network.js';
import { startSync } from './core/sync.js';
import { readClipboard, writeClipboard } from './core/clipboard.js';
import { hubCandidates } from './shared/connect.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const PORT = 47615;
const ICON = path.join(ROOT, 'icon.png');
const KIND = isMac ? 'mac' : 'pc';

if (process.env.PHONEDROP_USER_DATA) app.setPath('userData', process.env.PHONEDROP_USER_DATA);

// --- Settings ---------------------------------------------------------------
// Stored in the app's folder, readable only by you (the passphrase too).

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

let config = loadConfig();
let saveDir;
const isConfigured = () => !!(config.passphrase && config.device && (config.role === 'hub' || config.hubAddress));

// Accepts "My-Mac.local", "192.168.1.20:47615" or a full URL.
function normalizeHubAddress(input) {
  const raw = input.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!url.port) url.port = String(PORT);
  return url.origin;
}

// --- Hub and sync -----------------------------------------------------------

let hub = null;
let sync = null;
let hubError = null;
let restarting = Promise.resolve();
const received = []; // files that arrived this session, newest first
const sent = []; // files sent this session

async function stopServices() {
  sync?.stop();
  sync = null;
  await hub?.close();
  hub = null;
}

async function startServices() {
  await stopServices();
  hubError = null;
  if (!isConfigured()) return changed();

  if (config.role === 'hub') {
    try {
      hub = await startHub({ port: PORT, certDir: path.join(app.getPath('userData'), 'certs') });
    } catch (err) {
      hubError = err.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is PhoneDrop already running?` : err.message;
      return changed();
    }
  }

  sync = await startSync({
    candidates,
    passphrase: config.passphrase,
    device: config.device,
    deviceId: config.deviceId,
    kind: KIND,
    readClipboard,
    writeClipboard,
    saveFile,
    onEvent(event, state) {
      if (event.type === 'endpoints' && config.role === 'join') {
        config.endpoints = state.endpoints; // the hub's Tailscale address, for when you're away
        saveConfig();
      }
      if (event.type === 'received-file') {
        const c = event.clip;
        received.unshift({ id: c.id, name: path.basename(c.savedPath), size: c.size, from: c.from, path: c.savedPath });
        received.length = Math.min(received.length, 50);
        if (!win?.isVisible()) notify(c.name, `From ${c.from}`, () => shell.showItemInFolder(c.savedPath));
      }
      if (event.type === 'sent' && event.clip.kind === 'file') {
        const to = event.clip.to && [...state.devices.values()].find((d) => d.id === event.clip.to);
        sent.unshift({ name: event.clip.name, size: event.clip.size, to: to ? to.name : 'all devices' });
        sent.length = Math.min(sent.length, 20);
      }
      if (event.type === 'error') notify('PhoneDrop', event.message);
      changed();
    },
  });
  sync.setPaused(!!config.paused);
}

function restartServices() {
  restarting = restarting.then(startServices).catch((err) => {
    hubError = err.message;
    changed();
  });
  return restarting;
}

// At home: the hub's Wi-Fi addresses. Away: its Tailscale address.
function candidates() {
  if (config.role === 'hub') return [{ url: `ws://localhost:${PORT}/ws`, tier: 0 }];
  return hubCandidates(config.endpoints, { extra: [config.hubAddress] });
}

// What the popup shows.
function view() {
  const devices = [...new Map([...(sync?.state.devices.values() ?? [])].map((d) => [d.id, d])).values()];
  const clips = (sync?.state.recent ?? []).filter((c) => c.kind !== 'file').slice(0, 8)
    .map((c) => ({ id: c.id, kind: c.kind, text: c.text, size: c.size, from: c.from, mine: c.fromId === config.deviceId }));
  return {
    configured: isConfigured(),
    status: sync?.state.status ?? 'offline',
    via: sync?.state.via,
    paused: !!config.paused,
    hubError,
    role: config.role,
    device: config.device,
    devices,
    clips,
    received,
    sent,
  };
}

let changeQueued = false;
function changed() {
  if (changeQueued) return;
  changeQueued = true;
  setImmediate(() => {
    changeQueued = false;
    win?.webContents.send('state', view());
    renderTrayMenu();
  });
}

// --- Files ------------------------------------------------------------------

function uniquePath(dir, name) {
  name = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  const { name: base, ext } = path.parse(name);
  let p = path.join(dir, name), n = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++})${ext}`);
  return p;
}

function saveFile({ name, bytes }) {
  fs.mkdirSync(saveDir, { recursive: true });
  const dest = uniquePath(saveDir, name);
  fs.writeFileSync(dest, bytes);
  return dest;
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

// `to` = a device id, or null for all your devices.
async function sendFiles(paths, to = null) {
  if (!sync) return { error: 'Set up PhoneDrop first' };
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) await sync.sendFile(p, { to });
    } catch (err) {
      notify("Couldn't send file", err.message);
      return { error: err.message };
    }
  }
  return { ok: true };
}

// Uses the OS thumbnailer (handles HEIC etc. when codecs are installed); null if not an image
async function thumbnail(p, size) {
  try {
    const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
    return img.isEmpty() ? null : img;
  } catch { return null; }
}

// --- Phone setup info -------------------------------------------------------

// The phone sets itself up from the hub's plain-HTTP page (the QR code).
function phoneUrl() {
  if (config.role === 'join' && config.hubAddress) return config.hubAddress.replace(/^https:/, 'http:');
  return `http://${localHostname()}:${PORT}`;
}

async function info() {
  const url = phoneUrl();
  return {
    url,
    ips: config.role === 'join' ? [] : lanAddresses().map((ip) => `http://${ip}:${PORT}`),
    qr: await QRCode.toDataURL(url, { margin: 1, width: 440 }),
    saveDir,
    pc: config.device || computerName(),
  };
}

// --- Popup window -----------------------------------------------------------

let win;
let tray;
let quitting = false;
const POPUP = { width: 400, height: 640 };
let pinned = false;     // keep the popup open when it loses focus (needed to drag files in)
let dialogOpen = false; // native file dialogs steal focus; don't hide while one is open

// Pops the window up next to the tray icon, like a menu-bar app
function showWindow() {
  if (!win) return;
  const b = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  let x = Math.round(b.x + b.width / 2 - POPUP.width / 2);
  let y = b.y > wa.y + wa.height / 2 ? b.y - POPUP.height - 8 : b.y + b.height + 8;
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - POPUP.width - 8);
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - POPUP.height - 8);
  win.setBounds({ x, y, ...POPUP });
  if (isMac) app.focus({ steal: true });
  win.show();
  win.focus();
}
const toggleWindow = () => (win.isVisible() ? win.hide() : showWindow());

function openSettings() {
  showWindow();
  win.webContents.send('open-settings');
}

// --- Start at login ---------------------------------------------------------
// Registers this app to launch at login, hidden in the tray. Works for both
// the dev setup (electron + app path) and a packaged build.

const loginArgs = () => (app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']);
function setAutoStart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginArgs() });
}
const autoFlag = () => (app.isPackaged ? 'autoStartPackaged' : 'autoStartSet');
const autoStartEnabled = () => app.getLoginItemSettings({ path: process.execPath, args: loginArgs() }).openAtLogin;

// --- Tray -------------------------------------------------------------------

function trayIcon() {
  if (!isMac) return ICON;
  const icon = nativeImage.createFromPath(path.join(ROOT, 'icons', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  return icon;
}

let trayMenu;
function renderTrayMenu() {
  if (!tray) return;
  trayMenu = Menu.buildFromTemplate([
    { label: 'Open PhoneDrop', click: showWindow },
    { label: 'Open received folder', click: () => shell.openPath(saveDir) },
    { type: 'separator' },
    {
      label: 'Pause clipboard sync', type: 'checkbox', checked: !!config.paused, enabled: isConfigured(),
      click: (item) => setPaused(item.checked),
    },
    { label: 'Settings…', click: openSettings },
    {
      label: isMac ? 'Open at login' : 'Start with Windows', type: 'checkbox', checked: autoStartEnabled(),
      click: (item) => {
        setAutoStart(item.checked);
        config[autoFlag()] = item.checked;
        saveConfig();
        renderTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('PhoneDrop');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
  // Mac: drop files on the menu-bar icon to send them
  tray.on('drop-files', (_e, files) => {
    const devices = view().devices;
    sendFiles(files, devices.length === 1 ? devices[0].id : null);
  });
  renderTrayMenu();
}

function setPaused(paused) {
  config.paused = !!paused;
  saveConfig();
  sync?.setPaused(config.paused);
  changed();
}

// --- IPC --------------------------------------------------------------------

ipcMain.handle('info', info);
ipcMain.handle('state', view);
ipcMain.handle('settings', () => ({
  role: config.role || 'hub',
  hubAddress: config.hubAddress || '',
  device: config.device || computerName(),
  hasPassphrase: !!config.passphrase,
  configured: isConfigured(),
  thisHub: { url: `http://${localHostname()}:${PORT}`, tailscale: tailscaleAddresses() },
  awayAddresses: (config.endpoints?.tailscale || []).map((u) => new URL(u).hostname),
}));
ipcMain.handle('saveSettings', async (_e, input) => {
  const next = { ...config };
  next.role = input.role === 'join' ? 'join' : 'hub';
  if (next.role === 'join') {
    try {
      next.hubAddress = normalizeHubAddress(input.hubAddress || '');
    } catch {
      return { ok: false, error: "That hub address doesn't look right. Try something like My-Mac.local" };
    }
  }
  if (next.role !== config.role || next.hubAddress !== config.hubAddress) delete next.endpoints; // a different hub
  next.device = (input.device || '').trim().slice(0, 40);
  if (!next.device) return { ok: false, error: 'Give this computer a name.' };
  if (input.passphrase) {
    if (input.passphrase.length < 8) return { ok: false, error: 'Use a passphrase of at least 8 characters.' };
    next.passphrase = input.passphrase;
  }
  if (!next.passphrase) return { ok: false, error: 'Choose a passphrase.' };
  config = next;
  saveConfig();
  await restartServices();
  return hubError ? { ok: false, error: hubError } : { ok: true, hubAddress: config.hubAddress };
});
ipcMain.handle('setPaused', (_e, v) => setPaused(v));
ipcMain.handle('setPinned', (_e, v) => { pinned = !!v; return pinned; });
ipcMain.handle('hide', () => win.hide());
ipcMain.handle('openFolder', () => shell.openPath(saveDir));
ipcMain.handle('showFile', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('thumb', async (_e, p, size = 96) => {
  const img = await thumbnail(p, size);
  return img ? img.toDataURL() : null;
});
ipcMain.handle('sendFiles', (_e, paths, to) => sendFiles(paths, to));
ipcMain.handle('pickFiles', async (_e, to) => {
  dialogOpen = true;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }).finally(() => { dialogOpen = false; });
  return r.canceled ? { ok: true } : sendFiles(r.filePaths, to);
});
// Clicking a clip in the Clipboard list copies it again.
ipcMain.handle('copyClip', async (_e, id) => {
  const clip = sync?.state.recent.find((c) => c.id === id);
  if (!clip) return;
  if (clip.kind === 'image') writeClipboard({ kind: 'image', png: await sync.getData(clip) });
  else writeClipboard({ kind: 'text', text: clip.text });
});
ipcMain.handle('chooseFolder', async () => {
  dialogOpen = true;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: saveDir }).finally(() => { dialogOpen = false; });
  if (!r.canceled) {
    saveDir = r.filePaths[0];
    config.saveDir = saveDir;
    saveConfig();
  }
  return info();
});

// --- Startup ----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);
}

app.whenReady().then(async () => {
  if (isMac) app.dock?.hide();
  config.deviceId ??= crypto.randomBytes(8).toString('hex');
  saveDir = config.saveDir || path.join(app.getPath('pictures'), 'PhoneDrop');
  fs.mkdirSync(saveDir, { recursive: true });
  // On by default; re-applied each launch so the registered path follows the install location
  if (app.isPackaged && config[autoFlag()] !== false) {
    setAutoStart(true);
    config[autoFlag()] = true;
  }
  saveConfig();

  win = new BrowserWindow({
    ...POPUP, title: 'PhoneDrop', icon: ICON, show: false,
    frame: false, resizable: false, maximizable: false, minimizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.on('blur', () => { if (!pinned && !dialogOpen) win.hide(); });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  buildTray();
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  // Normally stays hidden until the tray icon is clicked; a manual launch (or first run) shows it once
  const atLogin = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!atLogin || !isConfigured()) win.once('ready-to-show', isConfigured() ? showWindow : openSettings);
  await restartServices();
});
app.on('window-all-closed', () => {}); // keep running in the tray
app.on('before-quit', () => { quitting = true; stopServices(); });
