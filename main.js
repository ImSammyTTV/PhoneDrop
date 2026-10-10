const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, screen } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const PORT = 47615;
const configFile = () => path.join(app.getPath('userData'), 'config.json');
let saveDir;
let win;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function saveConfig(c) { fs.writeFileSync(configFile(), JSON.stringify(c)); }

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  // Prefer typical home-router ranges over virtual adapters
  return out.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
}

function uniquePath(dir, name) {
  name = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  const { name: base, ext } = path.parse(name);
  let p = path.join(dir, name), n = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++})${ext}`);
  return p;
}

const outbox = [];
let nextId = 1;
const devices = new Map(); // id -> { id, name, lastSeen }
const ONLINE_MS = 7000;

const summary = () => outbox.map(({ id, name, size, to, path }) => ({ id, name, size, to, path }));

// Uses the OS thumbnailer (handles HEIC etc. when codecs are installed); null if not an image
async function thumbnail(p, size) {
  try {
    const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
    return img.isEmpty() ? null : img;
  } catch { return null; }
}

function deviceName(ua, kind) {
  // iPadOS Safari reports itself as a Mac, so the page tells us what it really is
  if (kind === 'ipad') return 'iPad';
  if (kind === 'iphone') return 'iPhone';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Browser';
}

function touchDevice(id, ua, kind) {
  if (!id) return;
  let d = devices.get(id);
  if (!d) {
    d = { id, name: deviceName(ua || '', kind), lastSeen: 0 };
    const same = [...devices.values()].filter((x) => x.name.replace(/ d+$/, '') === d.name).length;
    if (same) d.name += ' ' + (same + 1);
    devices.set(id, d);
  }
  d.lastSeen = Date.now();
}

function onlineDevices() {
  return [...devices.values()].filter((d) => Date.now() - d.lastSeen < ONLINE_MS);
}

// `to` = device id, or null to make the file available to every device
function addToOutbox(paths, to = null) {
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      outbox.push({ id: nextId++, name: path.basename(p), size: st.size, path: p, to });
    } catch {}
  }
  return summary();
}

function startServer() {
  const page = fs.readFileSync(path.join(__dirname, 'renderer', 'phone.html'));
  http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.method === 'GET' && req.url.startsWith('/files')) {
      const d = new URL(req.url, 'http://x').searchParams.get('d');
      const q = new URL(req.url, 'http://x').searchParams;
      touchDevice(d, req.headers['user-agent'], q.get('k'));
      const files = outbox.filter((o) => o.to === null || o.to === d).map(({ id, name, size }) => ({ id, name, size }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ pc: os.hostname(), files }));
    }
    if (req.method === 'GET' && req.url.startsWith('/preview/')) {
      const f = outbox.find((o) => o.id === Number(req.url.slice(9)));
      const img = f && (await thumbnail(f.path, 320));
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=300' });
      return res.end(img.toJPEG(80));
    }
    const dl = req.method === 'GET' && req.url.match(/^\/download\/(\d+)$/);
    if (dl) {
      const f = outbox.find((o) => o.id === Number(dl[1]));
      if (!f || !fs.existsSync(f.path)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(f.path).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      });
      return fs.createReadStream(f.path).pipe(res);
    }
    if (req.method === 'PUT' && req.url === '/upload') {
      fs.mkdirSync(saveDir, { recursive: true });
      const name = decodeURIComponent(req.headers['x-filename'] || 'file');
      const dest = uniquePath(saveDir, name);
      const out = fs.createWriteStream(dest);
      req.pipe(out);
      out.on('finish', () => {
        win && win.webContents.send('received', { name: path.basename(dest), size: fs.statSync(dest).size, path: dest });
        res.writeHead(200); res.end('ok');
      });
      out.on('error', () => { res.writeHead(500); res.end('error'); });
      req.on('aborted', () => { out.destroy(); fs.unlink(dest, () => {}); });
      return;
    }
    res.writeHead(404); res.end();
  }).listen(PORT, '0.0.0.0');
}

async function info() {
  const ip = lanAddresses()[0] || 'localhost';
  const url = `http://${ip}:${PORT}`;
  return { url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }), saveDir, pc: os.hostname() };
}

const ICON = path.join(__dirname, 'icon.png');
let tray;
let quitting = false;

const POPUP = { width: 400, height: 600 };
let pinned = false;     // keep the popup open when it loses focus (needed to drag files in from Explorer)
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
  win.show();
  win.focus();
}
const toggleWindow = () => (win.isVisible() ? win.hide() : showWindow());

// Registers this app to launch at login, hidden in the tray. Works for both
// the dev setup (electron.exe + app path) and a packaged build.
function setAutoStart(on) {
  app.setLoginItemSettings({
    openAtLogin: on,
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
  });
}
const autoFlag = () => (app.isPackaged ? 'autoStartPackaged' : 'autoStartSet');
const autoStartEnabled = () => app.getLoginItemSettings({
  path: process.execPath,
  args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
}).openAtLogin;

function buildTray() {
  tray = new Tray(ICON);
  tray.setToolTip('PhoneDrop');
  tray.on('click', toggleWindow);
  const render = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PhoneDrop', click: showWindow },
    { label: 'Open received folder', click: () => shell.openPath(saveDir) },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox', checked: autoStartEnabled(),
      click: (item) => {
        setAutoStart(item.checked);
        saveConfig({ ...loadConfig(), [autoFlag()]: item.checked });
        render();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  render();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  saveDir = loadConfig().saveDir || path.join(app.getPath('pictures'), 'PhoneDrop');
  fs.mkdirSync(saveDir, { recursive: true });
  startServer();
  win = new BrowserWindow({
    ...POPUP, title: 'PhoneDrop', icon: ICON, show: false,
    frame: false, resizable: false, maximizable: false, minimizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.on('blur', () => { if (!pinned && !dialogOpen) win.hide(); });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  buildTray();
  // First run: turn on start-with-Windows by default (toggle it from the tray menu)
  const cfg = loadConfig();
  // On by default; re-applied each launch so the registered path follows the install location
  if (app.isPackaged && cfg[autoFlag()] !== false) { setAutoStart(true); saveConfig({ ...cfg, [autoFlag()]: true }); }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Normally stays hidden until the tray icon is clicked; a manual launch shows it once
  if (!process.argv.includes('--hidden')) win.once('ready-to-show', showWindow);
  ipcMain.handle('setPinned', (_, v) => { pinned = !!v; return pinned; });
  ipcMain.handle('hide', () => win.hide());
  ipcMain.handle('info', info);
  ipcMain.handle('openFolder', () => shell.openPath(saveDir));
  ipcMain.handle('showFile', (_, p) => shell.showItemInFolder(p));
  ipcMain.handle('thumb', async (_, p, size = 96) => {
    const img = await thumbnail(p, size);
    return img ? img.toDataURL() : null;
  });
  ipcMain.handle('addFiles', (_, paths, to) => addToOutbox(paths, to));
  ipcMain.handle('devices', () => ({ devices: onlineDevices(), outbox: summary() }));
  ipcMain.handle('pickFiles', async (_, to) => {
    dialogOpen = true;
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }).finally(() => { dialogOpen = false; });
    return addToOutbox(r.canceled ? [] : r.filePaths, to);
  });
  ipcMain.handle('removeFile', (_, id) => {
    const i = outbox.findIndex((o) => o.id === id);
    if (i >= 0) outbox.splice(i, 1);
    return summary();
  });
  ipcMain.handle('chooseFolder', async () => {
    dialogOpen = true;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: saveDir }).finally(() => { dialogOpen = false; });
    if (!r.canceled) { saveDir = r.filePaths[0]; saveConfig({ ...loadConfig(), saveDir }); }
    return info();
  });
});
app.on('before-quit', () => { quitting = true; });
