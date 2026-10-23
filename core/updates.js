// Optional update checks against PhoneDrop's GitHub releases. Nothing here runs
// unless you turn on "Check for updates" or choose "Check for updates…".
//
// Windows: electron-updater downloads the new installer in the background and
// installs it when PhoneDrop restarts (or when you click Restart to update).
// Mac: macOS only lets apps replace themselves when they're signed with an Apple
// Developer ID, so instead we show a notice, download the .dmg and open it.
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';

const RELEASES_URL = process.env.PHONEDROP_UPDATE_URL || 'https://api.github.com/repos/ImSammyTTV/PhoneDrop/releases/latest';
const FIRST_CHECK_MS = 5000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const useAutoUpdater = () => process.platform === 'win32' && app.isPackaged;

// Is version a newer than version b? ("2.1.0" vs "2.0.1")
export function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// status: idle | checking | none | available | downloading | downloaded | ready | error
// `manual` is true when the last check was one you asked for (so "up to date" is worth showing).
export function createUpdater({ onChange }) {
  const state = { status: 'idle', version: null, progress: 0, error: null, manual: false, file: null };
  let release = null;
  let timer = null;
  let autoUpdater = null;
  let lastProgress = 0;

  const set = (patch) => {
    Object.assign(state, patch);
    onChange(state);
  };

  async function windowsUpdater() {
    if (autoUpdater) return autoUpdater;
    const mod = await import('electron-updater');
    autoUpdater = mod.autoUpdater ?? mod.default.autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, progress: 0 }));
    autoUpdater.on('update-not-available', (info) => set({ status: 'none', version: info.version }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, progress: 100 }));
    autoUpdater.on('error', (err) => set({ status: 'error', error: err.message }));
    return autoUpdater;
  }

  async function check({ manual = false } = {}) {
    if (['checking', 'downloading', 'ready', 'downloaded'].includes(state.status)) return;
    set({ status: 'checking', manual, error: null });
    try {
      if (useAutoUpdater()) {
        await (await windowsUpdater()).checkForUpdates();
        return;
      }
      const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PhoneDrop' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      release = await res.json();
      const version = String(release.tag_name).replace(/^v/, '');
      set(isNewer(version, app.getVersion()) ? { status: 'available', version } : { status: 'none', version });
    } catch (err) {
      set({ status: 'error', error: err.message });
    }
  }

  // Mac (and development builds): download the installer for this computer.
  async function download() {
    if (state.status !== 'available' || !release) return;
    const want = process.platform === 'darwin' ? `-${process.arch}.dmg` : '.exe';
    const asset = release.assets?.find((a) => a.name.endsWith(want));
    if (!asset) return shell.openExternal(release.html_url); // no download for this computer; show the release page
    set({ status: 'downloading', progress: 0 });
    try {
      const res = await fetch(asset.browser_download_url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      const dir = app.getPath('downloads');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, path.basename(asset.name));
      const partial = `${file}.download`;
      const out = fs.createWriteStream(partial);
      let received = 0;
      for await (const chunk of res.body) {
        out.write(chunk);
        received += chunk.length;
        if (total && Date.now() - lastProgress > 250) {
          lastProgress = Date.now();
          set({ progress: Math.round((received / total) * 100) });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (total && received !== total) throw new Error('The download was incomplete');
      fs.renameSync(partial, file);
      set({ status: 'downloaded', progress: 100, file });
      if (!process.env.PHONEDROP_UPDATE_URL) shell.openPath(file); // not during automated tests
    } catch (err) {
      set({ status: 'error', error: err.message, manual: true });
    }
  }

  return {
    state,
    check,
    download,
    // Windows: quit and run the downloaded installer now.
    install() {
      if (state.status === 'ready' && autoUpdater) autoUpdater.quitAndInstall(true, true);
    },
    openDownloaded() {
      if (state.file) shell.openPath(state.file);
    },
    // Automatic checks: a few seconds after start, then every 6 hours.
    setAutomatic(on) {
      clearTimeout(timer);
      clearInterval(timer);
      timer = null;
      if (!on) return;
      timer = setTimeout(() => {
        check();
        timer = setInterval(check, CHECK_EVERY_MS);
      }, FIRST_CHECK_MS);
    },
  };
}
