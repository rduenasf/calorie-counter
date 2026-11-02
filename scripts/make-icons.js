// Generates the PWA icons (green background, white plate ring) as PNGs with no dependencies.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const bg = [31, 138, 91];
  const fg = [255, 255, 255];
  const rows = [];
  const c = size / 2;
  const outer = size * 0.3, inner = size * 0.22, dot = size * 0.1;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // 1px anti-aliasing at shape edges
      const ring = Math.min(Math.max(outer - d + 0.5, 0), 1) * Math.min(Math.max(d - inner + 0.5, 0), 1);
      const center = Math.min(Math.max(dot - d + 0.5, 0), 1);
      const a = Math.max(ring, center);
      for (let i = 0; i < 3; i++) row[1 + x * 3 + i] = Math.round(bg[i] * (1 - a) + fg[i] * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(`public/icons/icon-${size}.png`, icon(size));
console.log("icons written");
