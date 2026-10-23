// Reads and writes this computer's clipboard for the sync engine: text, or
// images as PNG. Uses Electron's asynchronous, web-style clipboard (Electron 45+:
// readText / read / write / writeText all return promises).
// Watching for images is kept cheap: an image on the clipboard is only re-read
// every 2 s, and only sent when its contents have changed.
import crypto from 'node:crypto';
import { clipboard, ClipboardItem } from 'electron';

const IMAGE_CHECK_MS = 2000;

let lastImage = null;
let lastCheck = 0;

// For automated tests: an in-memory clipboard, so a test never touches yours.
const fake = process.env.PHONEDROP_FAKE_CLIPBOARD ? { item: null } : null;

const sha1 = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');

export async function readClipboard({ fresh = false } = {}) {
  if (fake) return fake.item;
  const text = await clipboard.readText();
  if (text) return { kind: 'text', text };
  if (!fresh && Date.now() - lastCheck < IMAGE_CHECK_MS) return lastImage;
  lastCheck = Date.now();
  const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
  if (!item) {
    lastImage = null;
    return null;
  }
  const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
  if (!png.length) return null;
  const fingerprint = sha1(png);
  if (lastImage?.fingerprint !== fingerprint) lastImage = { kind: 'image', fingerprint, getPng: () => png };
  return lastImage;
}

export async function writeClipboard(item) {
  if (fake) {
    fake.item = item.kind === 'image' ? { kind: 'image', fingerprint: sha1(item.png), getPng: () => item.png } : item;
    return;
  }
  if (item.kind === 'image') {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([item.png], { type: 'image/png' }) })]);
  } else {
    await clipboard.writeText(item.text);
  }
}
