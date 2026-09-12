// Draw the app icons: a hooded ninja, with the blade's trail behind.
// No image libraries in the toolchain, so this writes the PNGs and the .ico
// directly.
// Run: npm run icons
import fs from "node:fs";
import zlib from "node:zlib";

const OUT = process.env.ICON_OUT || new URL("../", import.meta.url).pathname;
const SIZES = (process.env.ICON_SIZES || "32,120,152,167,180,192,512").split(",").map(Number);

const BG_TOP = [0xff, 0x5d, 0x6d];   // the game's accent, lifted
const BG_BOT = [0xc7, 0x1f, 0x33];   // ... deepened toward the bottom
const HOOD = [0x11, 0x14, 0x1b];     // near-black, the app's own ground
const CLOTH = [0xf2, 0xf5, 0xfa];    // the eye band, as bright as a letter tile
const BLADE = [0x56, 0xe0, 0xff];    // the trail the game draws behind a cut

// ---- PNG plumbing ----------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;   // filter: None
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- shapes, sampled 3x3 per pixel for cheap antialiasing -------------------
const SAMPLES = [1 / 6, 3 / 6, 5 / 6];
function coverage(x, y, inside) {
  let hits = 0;
  for (const dx of SAMPLES) for (const dy of SAMPLES) if (inside(x + dx, y + dy)) hits++;
  return hits / 9;
}
const inRoundRect = (x0, y0, x1, y1, r) => (px, py) => {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const inEllipse = (cx, cy, rx, ry) => (px, py) =>
  ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
// A capsule: everything within half-width of the segment.
const inSegment = (ax, ay, bx, by, half) => (px, py) => {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2 <= half * half;
};
const both = (a, b) => (px, py) => a(px, py) && b(px, py);

// ---- the mark ---------------------------------------------------------------
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const u = (f) => f * size;

  // Built big and simple. At 60px on a home screen it is the band and the two
  // eyes that carry the icon, so nothing else competes with them: no outlines,
  // no small detail, one diagonal for movement.
  const head = inEllipse(u(0.5), u(0.555), u(0.305), u(0.34));
  const band = both(head, inRoundRect(u(0.10), u(0.415), u(0.90), u(0.558), u(0.03)));
  const eyeL = inRoundRect(u(0.345), u(0.450), u(0.458), u(0.518), u(0.029));
  const eyeR = inRoundRect(u(0.542), u(0.450), u(0.655), u(0.518), u(0.029));
  // The band's knotted ends, trailing off to the left.
  const tail1 = inSegment(u(0.22), u(0.462), u(0.035), u(0.395), u(0.024));
  const tail2 = inSegment(u(0.22), u(0.512), u(0.055), u(0.572), u(0.020));
  // The cut runs corner to corner and passes behind the head, so it reads as a
  // slash across the whole tile rather than a stick floating above one.
  const blade = inSegment(u(0.04), u(0.86), u(0.96), u(0.14), u(0.024));

  const layers = [
    { hit: blade, color: BLADE, alpha: 0.95 },
    { hit: tail1, color: CLOTH, alpha: 1 },
    { hit: tail2, color: CLOTH, alpha: 1 },
    { hit: head, color: HOOD, alpha: 1 },
    { hit: band, color: CLOTH, alpha: 1 },
    { hit: eyeL, color: HOOD, alpha: 1 },
    { hit: eyeR, color: HOOD, alpha: 1 }
  ];

  for (let y = 0; y < size; y++) {
    // Top-to-bottom gradient on the accent, so the flat red has some depth.
    const t = y / (size - 1);
    const bg = [0, 1, 2].map((i) => Math.round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t));
    for (let x = 0; x < size; x++) {
      let [r, g, b] = bg;
      for (const layer of layers) {
        const a = coverage(x, y, layer.hit) * layer.alpha;
        if (a <= 0) continue;
        r = Math.round(r * (1 - a) + layer.color[0] * a);
        g = Math.round(g * (1 - a) + layer.color[1] * a);
        b = Math.round(b * (1 - a) + layer.color[2] * a);
      }
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

// 120/152/167 are the iPad and older-iPhone home-screen sizes. 48 isn't listed:
// it exists only inside favicon.ico, so it needs no file of its own.
for (const size of SIZES) {
  const file = `${OUT}icon-${size}.png`;
  fs.writeFileSync(file, render(size));
  console.log(`${file} — ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}

// ---- favicon.ico -----------------------------------------------------------
// Safari reaches for a .ico when choosing a bookmark icon and skips SVG, and
// every app on this address shares one icon cache, so ship one.
function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: render(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const at = i * 16;
    dir[at] = img.size >= 256 ? 0 : img.size;
    dir[at + 1] = img.size >= 256 ? 0 : img.size;
    dir.writeUInt16LE(1, at + 4);          // colour planes
    dir.writeUInt16LE(32, at + 6);         // bits per pixel
    dir.writeUInt32LE(img.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const icoFile = OUT + "favicon.ico";
fs.writeFileSync(icoFile, ico([32, 48]));
console.log(`${icoFile} — ${(fs.statSync(icoFile).size / 1024).toFixed(1)} KB`);

// The same mark as scalable SVG.
fs.writeFileSync(OUT + "icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff5d6d" /><stop offset="1" stop-color="#c71f33" />
    </linearGradient>
    <clipPath id="head"><ellipse cx="50" cy="55.5" rx="30.5" ry="34" /></clipPath>
  </defs>
  <rect width="100" height="100" rx="18" fill="url(#bg)" />
  <line x1="4" y1="86" x2="96" y2="14" stroke="#56e0ff" stroke-width="4.8" stroke-linecap="round" opacity="0.95" />
  <line x1="22" y1="46.2" x2="3.5" y2="39.5" stroke="#f2f5fa" stroke-width="4.8" stroke-linecap="round" />
  <line x1="22" y1="51.2" x2="5.5" y2="57.2" stroke="#f2f5fa" stroke-width="4" stroke-linecap="round" />
  <ellipse cx="50" cy="55.5" rx="30.5" ry="34" fill="#11141b" />
  <g clip-path="url(#head)">
    <rect x="10" y="41.5" width="80" height="14.3" rx="3" fill="#f2f5fa" />
  </g>
  <rect x="34.5" y="45" width="11.3" height="6.8" rx="2.9" fill="#11141b" />
  <rect x="54.2" y="45" width="11.3" height="6.8" rx="2.9" fill="#11141b" />
</svg>\n`);
console.log(`${OUT}icon.svg`);
