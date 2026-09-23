#!/usr/bin/env node
//
// Draw the application icon and write it out as PNGs plus a multi-resolution
// Windows .ico.
//
//   node scripts/generate-app-icon.mjs
//
// The shipped icon was a placeholder: 32x32 and 128x128 of solid #FF0000, and
// an .ico containing a single 32x32 entry that Windows then scaled to every
// size it needed, from the 16px title bar to the 256px Explorer tile.
//
// The mark is a microphone flanked by range arcs — voice plus proximity, which
// is what the app is. Everything is drawn from distance functions at 4x and
// downsampled, so it stays crisp at 16px without hinting or a font dependency.
//
// No dependencies, matching the rest of this repo's tooling: PNG is IHDR +
// IDAT + IEND with a CRC32, and an .ico is just a small header in front of
// embedded PNGs.

import fs from 'node:fs';
import zlib from 'node:zlib';

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor

// Palette: the overlay's own dark navy and teal, so the icon and the in-game
// panel read as the same product.
const BG = [16, 20, 28];
const FG = [77, 216, 199];

// ---------------------------------------------------------------- rasteriser

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundRect(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - (halfW - r);
  const qy = Math.abs(y) - (halfH - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a line segment of the given half-thickness. */
function sdSegment(px, py, ax, ay, bx, by, thickness) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) - thickness;
}

/**
 * Is this point inside the mark? Coordinates are normalised to [-1, 1] with
 * the origin at the centre, so one description serves every output size.
 */
function inMark(x, y) {
  // Capsule: the microphone body.
  if (sdRoundRect(x, y + 0.14, 0.17, 0.34, 0.17) <= 0) return true;

  // Cradle: the U under the capsule, drawn as an annulus and clipped to the
  // lower half so it reads as an open arc rather than a ring.
  const cradle = Math.hypot(x, y + 0.14);
  if (y > -0.14 && Math.abs(cradle - 0.32) <= 0.055) return true;

  // Stand and base.
  if (sdSegment(x, y, 0, 0.18, 0, 0.44, 0.05) <= 0) return true;
  if (sdRoundRect(x, y - 0.5, 0.26, 0.055, 0.055) <= 0) return true;

  // Two range arcs each side, clipped to a wedge so they curve away from the
  // mic instead of closing into rings.
  const r = Math.hypot(x, y + 0.05);
  const openWedge = Math.abs(x) > Math.abs(y + 0.05) * 0.85;
  for (const radius of [0.56, 0.78]) {
    if (openWedge && Math.abs(r - radius) <= 0.055) return true;
  }
  return false;
}

/** Render one square RGBA frame at the given edge length. */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const inv = 1 / (size * SS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let markHits = 0, plateHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Sample at sub-pixel centres, mapped to [-1, 1].
          const u = ((x * SS + sx + 0.5) * inv) * 2 - 1;
          const v = ((y * SS + sy + 0.5) * inv) * 2 - 1;
          if (sdRoundRect(u, v, 0.98, 0.98, 0.34) <= 0) plateHits++;
          if (inMark(u, v)) markHits++;
        }
      }
      const total = SS * SS;
      const plate = plateHits / total;
      const mark = markHits / total;
      const i = (y * size + x) * 4;
      // Composite mark over plate, plate over transparency.
      const alpha = Math.min(1, plate);
      const m = Math.min(mark, alpha);
      px[i] = Math.round(BG[0] * (alpha - m) + FG[0] * m);
      px[i + 1] = Math.round(BG[1] * (alpha - m) + FG[1] * m);
      px[i + 2] = Math.round(BG[2] * (alpha - m) + FG[2] * m);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, px) {
  const stride = size * 4;
  // One filter byte per scanline; filter 0 (None) compresses fine for flat art.
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Pack PNGs into an .ico. Vista+ reads PNG-compressed entries directly. */
function encodeIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const at = 6 + i * 16;
    header[at] = e.size >= 256 ? 0 : e.size;      // 0 means 256
    header[at + 1] = e.size >= 256 ? 0 : e.size;
    header[at + 2] = 0;  // palette size
    header[at + 3] = 0;  // reserved
    header.writeUInt16LE(1, at + 4);   // colour planes
    header.writeUInt16LE(32, at + 6);  // bits per pixel
    header.writeUInt32BE(0, at + 8);
    header.writeUInt32LE(e.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

// ---------------------------------------------------------------------- main

const entries = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
const bySize = new Map(entries.map((e) => [e.size, e.png]));

fs.writeFileSync('src-tauri/icons/32x32.png', bySize.get(32));
fs.writeFileSync('src-tauri/icons/128x128.png', bySize.get(128));
fs.writeFileSync('src-tauri/icons/icon.ico', encodeIco(entries));

console.log('wrote src-tauri/icons/32x32.png   ' + bySize.get(32).length + ' bytes');
console.log('wrote src-tauri/icons/128x128.png ' + bySize.get(128).length + ' bytes');
console.log('wrote src-tauri/icons/icon.ico    ' +
  fs.statSync('src-tauri/icons/icon.ico').size + ' bytes, ' + SIZES.length + ' sizes: ' +
  SIZES.join(', '));

// A quick look at the 32px frame, so a broken render is obvious without
// opening a file browser.
const preview = render(32);
console.log('\n32x32 preview:');
for (let y = 0; y < 32; y += 1) {
  let row = '';
  for (let x = 0; x < 32; x++) {
    const i = (y * 32 + x) * 4;
    const a = preview[i + 3];
    const teal = preview[i + 1] > 120;
    row += a < 40 ? ' ' : (teal ? '#' : '.');
  }
  console.log('  ' + row);
}
