#!/usr/bin/env node
//
// Derive the Summoner's Rift river footprint from the game's own minimap art
// and emit it as a compact bitmask module.
//
//   node scripts/generate-river-mask.mjs
//
// Why from the artwork instead of hand-written coordinates: the river is a
// bent diagonal band with pits hanging off it, and eyeballing its bounds from
// memory produces a plausible-looking region that is subtly wrong everywhere.
// `assets/minimap-blank-sr.png` is the actual map, so the water is simply
// there to be read off. The script prints an ASCII rendering of what it
// extracted — if that does not look like the river, do not ship it.
//
// No dependencies: PNG decoding is IHDR + inflate + un-filter, all via zlib.

import fs from 'node:fs';
import zlib from 'node:zlib';

const SRC = 'assets/minimap-blank-sr.png';
const OUT = 'src/services/river-mask.ts';
const GRID = 64;

/** Decode an 8-bit RGBA, non-interlaced PNG (which both minimap assets are). */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      depth = buf[off + 16];
      colour = buf[off + 17];
      interlace = buf[off + 20];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  if (depth !== 8 || colour !== 6 || interlace !== 0) {
    throw new Error(`${file}: expected 8-bit RGBA non-interlaced, got depth=${depth} colour=${colour} interlace=${interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[p + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = cur + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
      }
      px[y * stride + x] = v & 255;
    }
    p += stride;
  }
  return { width, height, px, stride, bpp };
}

/**
 * River water on this artwork is a desaturated slate blue: clearly bluer than
 * it is red, never far from its own green, and not near-black. The upper bound
 * on blue-minus-green is what keeps the saturated blue of team structure icons
 * out. Calibrated against sampled pixels, then checked against the printout.
 */
function isWater(r, g, b, a) {
  return a > 128 && (b - r) > 25 && (b - g) > -8 && (b - g) < 55 && (r + g + b) > 45;
}

const img = decodePng(SRC);
console.log(`decoded ${SRC}: ${img.width}x${img.height}`);

// The colour filter alone also lights up both bases, whose stonework is the
// same slate blue as the water. Geometry separates them cleanly: the river is
// the diagonal running north-west to south-east, while the bases sit at the
// two ends of the *other* diagonal. Intersecting the artwork with a band
// around the river's axis keeps the real shape — bends, pits and all — and
// drops everything that cannot be river by position.
const RIVER_BAND = 0.2;
function onRiverAxis(u, v) {
  return Math.abs(u - v) <= RIVER_BAND;
}

const bits = new Uint8Array(GRID * GRID);
let wetCells = 0;
for (let gy = 0; gy < GRID; gy++) {
  for (let gx = 0; gx < GRID; gx++) {
    const x0 = Math.floor(gx * img.width / GRID), x1 = Math.floor((gx + 1) * img.width / GRID);
    const y0 = Math.floor(gy * img.height / GRID), y1 = Math.floor((gy + 1) * img.height / GRID);
    let hit = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * img.stride + x * img.bpp;
        total++;
        if (isWater(img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3])) hit++;
      }
    }
    const u = (gx + 0.5) / GRID, v = (gy + 0.5) / GRID;
    const wet = total > 0 && hit / total > 0.25 && onRiverAxis(u, v);
    if (wet) { bits[gy * GRID + gx] = 1; wetCells++; }
  }
}

// Fill single-cell gaps so the band is continuous — a voice must not flicker
// dry for one step while walking along the river.
const smoothed = Uint8Array.from(bits);
for (let gy = 1; gy < GRID - 1; gy++) {
  for (let gx = 1; gx < GRID - 1; gx++) {
    if (bits[gy * GRID + gx]) continue;
    let neighbours = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) neighbours += bits[(gy + dy) * GRID + (gx + dx)];
      }
    }
    if (neighbours >= 5) { smoothed[gy * GRID + gx] = 1; wetCells++; }
  }
}

console.log('\nExtracted river (screen orientation, top-left = map north-west):');
for (let gy = 0; gy < GRID; gy += 2) {
  let row = '';
  for (let gx = 0; gx < GRID; gx += 1) row += smoothed[gy * GRID + gx] ? '#' : '.';
  console.log('  ' + row);
}
console.log(`\nwet cells: ${wetCells} / ${GRID * GRID} (${(100 * wetCells / (GRID * GRID)).toFixed(1)}%)`);

const bytes = Buffer.alloc(Math.ceil(GRID * GRID / 8));
for (let i = 0; i < GRID * GRID; i++) {
  if (smoothed[i]) bytes[i >> 3] |= 1 << (i & 7);
}

fs.writeFileSync(OUT, `// GENERATED by scripts/generate-river-mask.mjs — do not edit by hand.
//
// The Summoner's Rift river, read off the game's own minimap artwork
// (assets/minimap-blank-sr.png) rather than estimated from coordinates.
// Re-run the generator if the artwork is ever updated; it prints the extracted
// shape so the result can be eyeballed before committing.
//
// Stored as a ${GRID}x${GRID} bitmask in row-major *screen* order — row 0 is the
// north edge — which is why the lookup flips Y: game coordinates put the
// origin at the bottom-left.

import { Position, MapType, MAP_DIMENSIONS } from '../core/types';

const GRID = ${GRID};
const MASK = '${bytes.toString('base64')}';

// Decoded by hand rather than via atob() or Buffer: this module is imported
// by both the WebView bundle and the node-based test runner, and neither of
// those globals exists in both.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const bits = (() => {
  const clean = MASK.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let acc = 0, accBits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]);
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[o++] = (acc >> accBits) & 0xff;
    }
  }
  return out;
})();

/**
 * Is this position standing in the river?
 *
 * Howling Abyss has no river — it is one bridge over a chasm — so it always
 * answers false rather than borrowing Summoner's Rift's geometry.
 */
export function isInRiver(pos: Position | null | undefined, mapType: MapType): boolean {
  if (!pos || mapType !== 'summoners_rift') return false;
  const dims = MAP_DIMENSIONS.summoners_rift;
  const u = pos.x / dims.width;
  const v = 1 - pos.y / dims.height;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
  const gx = Math.min(GRID - 1, Math.floor(u * GRID));
  const gy = Math.min(GRID - 1, Math.floor(v * GRID));
  const i = gy * GRID + gx;
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}
`);
console.log(`\nwrote ${OUT}`);
