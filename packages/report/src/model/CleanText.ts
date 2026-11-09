// Small pure helpers shared by the parser and the renderers: escaping, hashing, sizes and number
// formats. No clock, no randomness, no input or output.
import { createHash } from 'node:crypto';

const HTML_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Well-formed UTF-16 with no C0 or C1 controls (except tab and newline), no bidirectional
// overrides or isolates and no zero-width marks; each is replaced by U+FFFD.
export function cleanText(text: string): string {
  return text.toWellFormed().replace(/[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu, '\u{fffd}');
}

// Escapes text for HTML content and for double- or single-quoted attributes.
export function escapeHtml(text: string): string {
  return cleanText(text).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

// Markdown-safe text for table cells, link text and image alt text: angle brackets and
// ampersands become entities (never a tag), and the other markup characters get a backslash.
export function markdownEscape(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').replace(/[&<>]/g, (character) => HTML_ENTITIES[character] ?? character)
    .replace(/[\\`*_{}[\]()#+!|~-]/g, (character) => `\\${character}`);
}

export const wordCount = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length);
export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const isHex64 = (text: string): boolean => /^[0-9a-f]{64}$/.test(text);
export const isId = (text: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text);

// Width and height from a PNG's header chunk, or null when the bytes are not a PNG.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export const roundToHundredths = (value: number): number => Math.round(value * 100) / 100;
// A share as a percentage with one decimal place, such as "75.0%".
export const formatPercent = (share: number): string => `${(Math.round(share * 1000) / 10).toFixed(1)}%`;

// The WCAG 2.x contrast ratio of two #rrggbb colours, from their relative luminance.
export function contrast(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5]
      .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}
