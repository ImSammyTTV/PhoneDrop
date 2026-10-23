// Renders the Mac app icon, the phone app icon and the Mac menu-bar glyph from
// their SVGs: npm run icons. (icon.png / icon.ico for Windows come from gen-icon.cjs.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appIcon = fs.readFileSync(path.join(ROOT, 'icon.svg'));
const trayGlyph = fs.readFileSync(path.join(ROOT, 'icons/tray.svg'));

for (const [svg, size, out] of [
  [appIcon, 1024, 'build/icon.png'], // electron-builder makes the Mac .icns from this
  [appIcon, 512, 'web/icon-512.png'],
  [trayGlyph, 16, 'icons/trayTemplate.png'],
  [trayGlyph, 32, 'icons/trayTemplate@2x.png'],
]) {
  fs.writeFileSync(path.join(ROOT, out), new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
  console.log(`${out} (${size}px)`);
}
