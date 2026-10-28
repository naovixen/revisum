// The leak scanner: reads files a run produced (results, event logs, reports, images) and reports
// every echo of the given secrets in them. Images are scanned as bytes, including the text chunks
// a PNG may carry, compressed or not; text drawn as pixels is out of reach of any text scan.
// The caller plants a canary secret in one file: a scan that does not find it is not to be trusted.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { Leak, LeakForm, LeakScanner, Secret } from '@revisum/contracts';
import { echoFormsIn } from './secret-values.ts';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// A compressed chunk that inflates past this is not read further, so a hostile image cannot
// exhaust memory.
const MAXIMUM_INFLATED_BYTES = 16 * 1024 * 1024;

// The option name is Node's own, so it is written as a quoted key.
function inflated(bytes: Buffer): string {
  try { return inflateSync(bytes, { 'maxOutputLength': MAXIMUM_INFLATED_BYTES }).toString('utf8'); } catch { return ''; }
}

// The text of a PNG's compressed text chunks (zTXt, and iTXt with its compression flag set),
// inflated. Uncompressed text chunks are already visible in the raw bytes.
function compressedPngText(bytes: Buffer): string[] {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return [];
  const texts: string[] = [];
  let position = PNG_SIGNATURE.length;
  while (position + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.toString('latin1', position + 4, position + 8);
    const data = bytes.subarray(position + 8, Math.min(position + 8 + length, bytes.length));
    const keywordEnd = data.indexOf(0);
    if (type === 'zTXt' && keywordEnd !== -1) texts.push(inflated(data.subarray(keywordEnd + 2)));
    if (type === 'iTXt' && keywordEnd !== -1 && data[keywordEnd + 1] === 1) {
      // After the keyword: compression flag, method, language tag and translated keyword, each
      // of the last two ending in a zero byte.
      const languageEnd = data.indexOf(0, keywordEnd + 3);
      const translatedEnd = languageEnd === -1 ? -1 : data.indexOf(0, languageEnd + 1);
      if (translatedEnd !== -1) texts.push(inflated(data.subarray(translatedEnd + 1)));
    }
    position += 12 + length;
  }
  return texts;
}

// The texts to search in a file: its bytes read as UTF-8 and, for binary content, byte for byte,
// plus any compressed PNG text.
const textsOf = (bytes: Buffer): string[] => [bytes.toString('utf8'), bytes.toString('latin1'), ...compressedPngText(bytes)];

export function leakScanner(): LeakScanner {
  return {
    scan(files: readonly string[], secrets: readonly Secret[]): readonly Leak[] {
      const leaks: Leak[] = [];
      if (secrets.length === 0) return leaks;
      for (const file of files) {
        const texts = textsOf(readFileSync(file));
        for (const secret of secrets) {
          const forms = new Set<LeakForm>(texts.flatMap((text) => echoFormsIn(text, secret)));
          for (const form of forms) leaks.push({ file, secret: secret.name, form });
        }
      }
      return leaks;
    },
  };
}
