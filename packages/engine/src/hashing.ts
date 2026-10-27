// Canonical JSON and SHA-256: the same value always gives the same bytes and the same hash.
import { createHash } from 'node:crypto';

// Sorted keys, no whitespace; rejects values JSON cannot represent exactly.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new TypeError(`unsupported value in canonical JSON: ${typeof value}`);
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
