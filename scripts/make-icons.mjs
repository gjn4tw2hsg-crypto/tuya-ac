// Renders the app icon (snowflake on a blue gradient) to PNG without dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function render(size, rounded) {
  const segs = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 - Math.PI / 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    segs.push([0, 0, ux * 0.62, uy * 0.62]);
    for (const [d, l] of [[0.34, 0.16], [0.5, 0.11]]) {
      for (const s of [-1, 1]) {
        const b = a + (s * Math.PI) / 4;
        segs.push([ux * d, uy * d, ux * d + Math.cos(b) * l, uy * d + Math.sin(b) * l]);
      }
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 3; // supersampling
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let cov = 0, snow = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const fx = (x + (sx + 0.5) / SS) / size, fy = (y + (sy + 0.5) / SS) / size;
        // rounded square mask (iOS masks its own corners, so full square when !rounded)
        let inside = true;
        if (rounded) {
          const r = 0.22, cx = Math.min(Math.max(fx, r), 1 - r), cy = Math.min(Math.max(fy, r), 1 - r);
          inside = Math.hypot(fx - cx, fy - cy) <= r;
        }
        if (!inside) continue;
        cov++;
        const px = (fx - 0.5) * 2.1, py = (fy - 0.5) * 2.1;
        let d = Infinity;
        for (const s of segs) d = Math.min(d, segDist(px, py, ...s));
        if (d < 0.055) snow++;
      }
      const n = SS * SS;
      const fy = y / size, fx = x / size;
      // gradient: #38bdf8 (top-left) → #1d4ed8 (bottom-right)
      const t = (fx + fy) / 2;
      const bg = [56 + (29 - 56) * t, 189 + (78 - 189) * t, 248 + (216 - 248) * t];
      const k = cov ? snow / cov : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(bg[0] * (1 - k) + 255 * k);
      raw[o + 1] = Math.round(bg[1] * (1 - k) + 255 * k);
      raw[o + 2] = Math.round(bg[2] * (1 - k) + 255 * k);
      raw[o + 3] = Math.round((cov / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync('public/apple-touch-icon.png', render(180, false));
writeFileSync('public/icon-192.png', render(192, true));
writeFileSync('public/icon-512.png', render(512, true));
writeFileSync('public/icon-maskable-512.png', render(512, false));
console.log('icons written');
