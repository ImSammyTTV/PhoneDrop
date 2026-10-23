// Reads and writes this computer's clipboard for the sync engine: text, or
// images as PNG. Watching for images is kept cheap: the raw image data is only
// fingerprinted every 1.5 s, and only converted to PNG when it has changed.
import crypto from 'node:crypto';
import { clipboard, nativeImage } from 'electron';

const IMAGE_CHECK_MS = 1500;
// Raw image formats apps commonly put on the clipboard, read without decoding.
const RAW_FORMATS = process.platform === 'darwin' ? ['public.png', 'public.tiff'] : ['PNG'];

let lastImage = null;
let lastCheck = 0;

// For automated tests: an in-memory clipboard, so a test never touches yours.
const fake = process.env.PHONEDROP_FAKE_CLIPBOARD ? { item: null } : null;

export function readClipboard({ fresh = false } = {}) {
  if (fake) return fake.item;
  const formats = clipboard.availableFormats();
  if (formats.includes('text/plain')) {
    const text = clipboard.readText();
    if (text) return { kind: 'text', text };
  }
  if (!formats.some((f) => f.startsWith('image/'))) {
    lastImage = null;
    return null;
  }
  if (!fresh && lastImage && Date.now() - lastCheck < IMAGE_CHECK_MS) return lastImage;
  lastCheck = Date.now();
  const raw = RAW_FORMATS.map((f) => clipboard.readBuffer(f)).find((b) => b.length) ?? clipboard.readImage().toBitmap();
  if (!raw.length) return null;
  const fingerprint = crypto.createHash('sha1').update(raw).digest('hex');
  if (lastImage?.fingerprint !== fingerprint) {
    lastImage = { kind: 'image', fingerprint, getPng: () => clipboard.readImage().toPNG() };
  }
  return lastImage;
}

export function writeClipboard(item) {
  if (fake) {
    fake.item = item.kind === 'image' ? { kind: 'image', fingerprint: crypto.createHash('sha1').update(item.png).digest('hex'), getPng: () => item.png } : item;
    return;
  }
  if (item.kind === 'image') clipboard.writeImage(nativeImage.createFromBuffer(item.png));
  else clipboard.writeText(item.text);
}
