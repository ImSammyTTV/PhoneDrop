// Generates icon.png (256x256) and icon.ico with no dependencies. Run: node gen-icon.js
const fs = require('fs');
const zlib = require('zlib');

const S = 256, SS = 4;
const inPoly = (x, y, p) => {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if ((p[i][1] > y) !== (p[j][1] > y) &&
        x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
};
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const white = [
  rect(54, 86, 154, 106), [[148, 62], [204, 96], [148, 130]],
  rect(102, 150, 202, 170), [[108, 126], [52, 160], [108, 194]],
];
const inRounded = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), S - r), cy = Math.min(Math.max(y, r), S - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const top = [0x5b, 0x8c, 0xff], bot = [0x2f, 0x55, 0xe0];

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        if (!inRounded(px, py, 52)) continue;
        bg++;
        if (white.some((p) => inPoly(px, py, p))) fg++;
      }
    const n = SS * SS, t = y / S;
    const o = y * (S * 4 + 1) + 1 + x * 4;
    const f = bg ? fg / bg : 0;
    for (let k = 0; k < 3; k++) {
      const base = top[k] + (bot[k] - top[k]) * t;
      raw[o + k] = Math.round(base * (1 - f) + 255 * f);
    }
    raw[o + 3] = Math.round((bg / n) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(__dirname + '/icon.png', png);

// ICO container wrapping the 256x256 PNG
const hdr = Buffer.alloc(22);
hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
hdr[6] = 0; hdr[7] = 0; hdr.writeUInt16LE(1, 10); hdr.writeUInt16LE(32, 12);
hdr.writeUInt32LE(png.length, 14); hdr.writeUInt32LE(22, 18);
fs.writeFileSync(__dirname + '/icon.ico', Buffer.concat([hdr, png]));
console.log('wrote icon.png, icon.ico');
