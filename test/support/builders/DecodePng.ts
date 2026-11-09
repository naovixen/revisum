// A minimal PNG decoder (8-bit RGB or RGBA, not interlaced) on Node built-ins, so pixel checks
// need no third-party package. Browser screenshots use exactly these formats.
import { inflateSync } from 'node:zlib';

export type DecodedImage = { readonly width: number; readonly height: number; readonly channels: number; readonly data: Uint8Array };

export function decodePng(bytes: Uint8Array): DecodedImage {
  const buffer = Buffer.from(bytes);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const compressed: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (chunkType === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8] ?? 0;
      colourType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (chunkType === 'IDAT') {
      compressed.push(body);
    } else if (chunkType === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG ${bitDepth}/${colourType}/${interlace}`);
  }
  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const above = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const aboveLeft = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      const value = raw[rowStart + x] ?? 0;
      let decoded: number;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = value + left; break;
        case 2: decoded = value + above; break;
        case 3: decoded = value + ((left + above) >> 1); break;
        case 4: {
          const estimate = left + above - aboveLeft;
          const toLeft = Math.abs(estimate - left);
          const toAbove = Math.abs(estimate - above);
          const toAboveLeft = Math.abs(estimate - aboveLeft);
          decoded = value + (toLeft <= toAbove && toLeft <= toAboveLeft ? left : toAbove <= toAboveLeft ? above : aboveLeft);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[y * stride + x] = decoded & 0xff;
    }
  }
  return { width, height, channels, data: pixels };
}
