// A minimal PNG decoder (8-bit RGB or RGBA, not interlaced) on Node built-ins, used to read the
// background pixels behind text.
import { inflateSync } from 'node:zlib';

export interface DecodedImage { width: number; height: number; channels: number; data: Uint8Array }

export function decodePng(buffer: Buffer): DecodedImage {
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

const linearChannel = (channel: number): number => {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
};
// WCAG relative luminance of an sRGB colour.
export const luminance = (red: number, green: number, blue: number): number =>
  0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);

// The darkest and the brightest pixel, by relative luminance.
export function extremes(image: DecodedImage): { dark: [number, number, number]; light: [number, number, number] } {
  let lowest = Infinity;
  let highest = -Infinity;
  let dark: [number, number, number] = [0, 0, 0];
  let light: [number, number, number] = [255, 255, 255];
  for (let i = 0; i < image.data.length; i += image.channels) {
    const red = image.data[i] ?? 0;
    const green = image.data[i + 1] ?? 0;
    const blue = image.data[i + 2] ?? 0;
    const value = luminance(red, green, blue);
    if (value < lowest) { lowest = value; dark = [red, green, blue]; }
    if (value > highest) { highest = value; light = [red, green, blue]; }
  }
  return { dark, light };
}
