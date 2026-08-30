/**
 * Generate `resources/icon.png` — the 128x128 marketplace icon.
 *
 * The marketplace rejects SVG, so the shape in `resources/icon.svg` (three nodes,
 * a trunk, and a branch) is rasterised here and the PNG is written by hand with
 * `node:zlib`. No image dependency is added for one 128px file.
 *
 * PNG is small enough to emit directly: 8-byte signature, then length/type/data/CRC
 * chunks — IHDR, IDAT (deflated RGBA scanlines, each prefixed by filter byte 0),
 * IEND.
 *
 * Run: `node scripts/make-icon.js`
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 128;
/** icon.svg is authored on a 24x24 grid. */
const SCALE = SIZE / 24;
/** Git orange: legible on the marketplace's light AND dark backgrounds. */
const COLOR = [0xf0, 0x50, 0x33];
const STROKE = 2.1 * SCALE;
const NODE_RADIUS = 2.2 * SCALE;

const NODES = [
  [6, 5],
  [6, 19],
  [18, 12],
];
const SEGMENTS = [
  // Trunk, between the two left nodes.
  [6, 7.2, 6, 16.8],
  // Branch, from the trunk out to the right node.
  [6, 12, 15.8, 12],
];

function main() {
  const pixels = render();
  const file = path.join(__dirname, '..', 'resources', 'icon.png');
  fs.writeFileSync(file, encodePng(SIZE, SIZE, pixels));
  process.stdout.write(`${file} ${fs.statSync(file).size} bytes ${SIZE}x${SIZE}\n`);
}

// ------------------------------------------------------------------- raster

/**
 * Analytic coverage instead of supersampling: every shape here is a circle or a
 * segment, so the exact distance to its skeleton is cheap and gives clean AA.
 */
function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const half = STROKE / 2;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const px = (x + 0.5) / SCALE;
      const py = (y + 0.5) / SCALE;
      let coverage = 0;
      for (const [cx, cy] of NODES) {
        // Filled node: a ring reads as mush at 16px, a disc survives.
        coverage = Math.max(coverage, cover(Math.hypot(px - cx, py - cy) * SCALE, NODE_RADIUS));
      }
      for (const [x1, y1, x2, y2] of SEGMENTS) {
        coverage = Math.max(coverage, cover(segmentDistance(px, py, x1, y1, x2, y2) * SCALE, half));
      }
      if (coverage <= 0) continue;
      const offset = (y * SIZE + x) * 4;
      out[offset] = COLOR[0];
      out[offset + 1] = COLOR[1];
      out[offset + 2] = COLOR[2];
      out[offset + 3] = Math.round(Math.min(1, coverage) * 255);
    }
  }
  return out;
}

/** One pixel of linear falloff across the edge. */
function cover(distance, radius) {
  return clamp(radius - distance + 0.5, 0, 1);
}

function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / lengthSquared, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------- png bytes

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();
