// Draw the app icons: a letter tile with a blade through it. No image libraries
// in the toolchain, so this writes the PNGs and the .ico directly.
// Run: npm run icons
import fs from "node:fs";
import zlib from "node:zlib";

const OUT = new URL("../", import.meta.url).pathname;

const BG = [0x14, 0x18, 0x21];
const TILE = [0xe9, 0xee, 0xf7];
const GLINT = [0x56, 0xe0, 0xff];

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
// A capsule: everything within half-width of the segment.
const inSegment = (ax, ay, bx, by, half) => (px, py) => {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2 <= half * half;
};

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const u = (f) => f * size;

  // A tile sliced in two: the same rounded square drawn twice, each half
  // clipped to one side of the cut and nudged away from it. The gap between
  // them is the cut, which reads better than a stripe laid over the top.
  const tile = inRoundRect(u(0.20), u(0.20), u(0.80), u(0.80), u(0.115));
  const cx = u(0.5), cy = u(0.5);
  const angle = -0.62;                                  // rising to the right
  const nx = -Math.sin(angle), ny = Math.cos(angle);    // normal to the cut
  const off = u(0.035);                                 // how far each half slides

  const side = (px, py) => (px - cx) * nx + (py - cy) * ny;
  const halfAbove = (px, py) => tile(px + nx * off, py + ny * off) && side(px + nx * off, py + ny * off) < 0;
  const halfBelow = (px, py) => tile(px - nx * off, py - ny * off) && side(px - nx * off, py - ny * off) > 0;

  // A thin glint riding just behind the cut, so it still reads as a blade.
  const glint = inSegment(u(0.06) + nx * off * 2.2, u(0.79) + ny * off * 2.2,
                          u(0.94) + nx * off * 2.2, u(0.21) + ny * off * 2.2, u(0.016));

  const layers = [
    { hit: halfAbove, color: TILE, alpha: 1 },
    { hit: halfBelow, color: TILE, alpha: 1 },
    { hit: glint, color: GLINT, alpha: 0.9 }
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b] = BG;
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

// 120/152/167 are the iPad and older-iPhone home-screen sizes. 48 isn't here:
// it exists only inside favicon.ico, so it needs no file of its own.
for (const size of [32, 120, 152, 167, 180, 192, 512]) {
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
  <rect width="100" height="100" rx="18" fill="#141821" />
  <defs>
    <clipPath id="above"><polygon points="-40,-40 140,-40 140,140" /></clipPath>
    <clipPath id="below"><polygon points="-40,-40 -40,140 140,140" /></clipPath>
  </defs>
  <g transform="rotate(-35.5 50 50)">
    <g clip-path="url(#above)"><rect x="20" y="16.5" width="60" height="60" rx="11.5" fill="#e9eef7" /></g>
    <g clip-path="url(#below)"><rect x="20" y="23.5" width="60" height="60" rx="11.5" fill="#e9eef7" /></g>
    <line x1="-6" y1="57" x2="106" y2="57" stroke="#56e0ff" stroke-width="3.2" stroke-linecap="round" opacity="0.9" />
  </g>
</svg>\n`);
console.log(`${OUT}icon.svg`);
