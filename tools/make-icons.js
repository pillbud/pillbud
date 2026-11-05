// Draws the placeholder pill icon (tray + extension) as PNGs, no image libraries needed.
//   node tools/make-icons.js
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** a tilted capsule: pink top, cream bottom, dark outline, two eyes. Supersampled for smooth edges. */
function pill(size) {
  const S = 4, W = size * S;
  const out = Buffer.alloc(size * size * 4);
  const ang = -0.6, ca = Math.cos(ang), sa = Math.sin(ang);
  const r = W * 0.2, half = W * 0.27; // capsule radius and half-length of the straight part
  const colorAt = (x, y) => {
    const dx = x - W / 2, dy = y - W / 2;
    const u = dx * ca - dy * sa, v = dx * sa + dy * ca; // capsule along v
    const cv = Math.max(-half, Math.min(half, v));
    const d = Math.hypot(u, v - cv);
    if (d > r) return null;
    if (d > r - W * 0.06) return [34, 24, 40];
    // eyes on the top half
    for (const ex of [-r * 0.42, r * 0.42]) {
      const ed = Math.hypot(u - ex, v + half * 0.55);
      if (ed < r * 0.2) return ed < r * 0.1 ? [20, 16, 24] : [255, 255, 255];
    }
    if (Math.abs(v) < W * 0.015) return [34, 24, 40];
    return v < 0 ? [255, 92, 138] : [255, 244, 222];
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let rr = 0, gg = 0, bb = 0, aa = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = colorAt(x * S + sx + 0.5, y * S + sy + 0.5);
      if (c) { rr += c[0]; gg += c[1]; bb += c[2]; aa++; }
    }
    const i = (y * size + x) * 4;
    if (aa) { out[i] = rr / aa; out[i + 1] = gg / aa; out[i + 2] = bb / aa; out[i + 3] = (aa / (S * S)) * 255; }
  }
  return png(size, size, out);
}

const root = path.join(__dirname, "..");
fs.mkdirSync(path.join(root, "extension", "icons"), { recursive: true });
fs.mkdirSync(path.join(root, "assets"), { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(root, "extension", "icons", `pill${s}.png`), pill(s));
fs.writeFileSync(path.join(root, "assets", "tray.png"), pill(32));
fs.writeFileSync(path.join(root, "assets", "tray@2x.png"), pill(64));
console.log("icons written");
