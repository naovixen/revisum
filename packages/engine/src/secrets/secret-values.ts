// The engine's one module that reads secret values. It is on the reveal allow-list because
// redaction and leak scanning cannot work without the value: they look for it, and for each form
// in which it can echo, in text a run keeps or wrote. Everything here returns redacted text, forms
// found, whether a text is a secret, a mode or a hash, never the value itself. A declared call's header scheme is applied here
// too, inside a new opaque Secret. The one exception is what the browser itself must receive: a
// stub's body or a storage entry's value, written here with its secret arguments in place just
// before the run hands it to the driver, which never reports it back.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import {
  MINIMUM_SECRET_LENGTH, createSecret, isSecret, reveal,
  type HeaderScheme, type JsonBodyWithSecrets, type LeakForm, type RedactionMode, type Secret,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';

// What replaces an echo of a secret in kept text.
export const SECRET_PLACEHOLDER = '[redacted:secret]';

// Short values are redacted by key: searching outputs for them would match ordinary text.
export const redactionModeOf = (secret: Secret): RedactionMode =>
  reveal(secret).length < MINIMUM_SECRET_LENGTH ? 'key-only' : 'value';

// Identifies a secret's content, such as a saved storage state, without revealing it.
export const secretSha256 = (secret: Secret): string => sha256(reveal(secret));

// Lower-cases each character whose lower-case form has the same length, so positions found in the
// folded text are positions in the original.
function foldCase(text: string): string {
  let folded = '';
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

const escapeForPattern = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

// ---- URL and form encoding ------------------------------------------------------------------------

// The percent escapes of one character's UTF-8 bytes: "%2f" for "/".
const percentEscapes = (character: string): string =>
  [...Buffer.from(character, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');

// A pattern for the value as any URL or form encoder may write it: each character as itself or
// percent-escaped, and a space also as "+", as forms and URLSearchParams write it. Encoders differ
// in which characters they escape (encodeURIComponent leaves "!" and "~" alone, URLSearchParams
// does not), so every character may take either form. The pattern ignores case, so hex digits may
// be upper or lower case and a case-changed echo is caught too.
function uriPattern(value: string): RegExp {
  const characters = [...value].map((character) => {
    const options = [escapeForPattern(character), percentEscapes(character)];
    if (character === ' ') options.push('\\+');
    return `(?:${options.join('|')})`;
  });
  return new RegExp(characters.join(''), 'gi');
}

// ---- Base64 inside longer text ---------------------------------------------------------------------

const BASE64_ALPHABETS = {
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
} as const;

// One base64 character as far as the value decides it: which of its six bits come from the value
// (knownBits) and what they are (bits). The other bits come from the bytes around the value.
type EncodedCharacter = { readonly knownBits: number; readonly bits: number };

// The base64 characters that hold the value's bits when the value starts `offset` bytes into a
// three-byte group, as it does inside a longer encoded text such as "user:password".
function encodedCharacters(bytes: Buffer, offset: number): EncodedCharacter[] {
  const characters: EncodedCharacter[] = [];
  const characterCount = Math.ceil(((offset + bytes.length) * 8) / 6);
  for (let character = 0; character < characterCount; character++) {
    let knownBits = 0;
    let bits = 0;
    for (let bit = 0; bit < 6; bit++) {
      const position = character * 6 + bit;
      const byte = bytes[Math.floor(position / 8) - offset];
      knownBits <<= 1;
      bits <<= 1;
      if (byte !== undefined) {
        knownBits |= 1;
        bits |= (byte >> (7 - (position % 8))) & 1;
      }
    }
    // A leading character that holds only the preceding bytes' bits says nothing about the value.
    if (knownBits !== 0) characters.push({ knownBits, bits });
  }
  return characters;
}

// A pattern for the value's base64 at each of the three alignments it can take inside a longer
// encoded text, with any padding when the value ends it. A character the value only partly decides
// matches every alphabet character that agrees on the value's bits, so all of the value's bits are
// checked: a near miss differs in some character and does not match, however short the value.
function base64Pattern(value: string, alphabet: string): RegExp {
  const bytes = Buffer.from(value, 'utf8');
  const alignments = [0, 1, 2].map((offset) => {
    const characters = encodedCharacters(bytes, offset).map(({ knownBits, bits }) => {
      const allowed = [...alphabet].filter((_, index) => (index & knownBits) === bits).map(escapeForPattern);
      return allowed.length === 1 ? allowed.join('') : `[${allowed.join('')}]`;
    });
    const padding = (offset + bytes.length) % 3 === 0 ? '' : '={0,2}';
    return `(?:${characters.join('')}${padding})`;
  });
  return new RegExp(alignments.join('|'), 'g');
}

// ---- Finding and redacting echoes ------------------------------------------------------------------

type EncodedEcho = { readonly form: 'uri' | 'base64' | 'base64url'; readonly pattern: RegExp };

// Every encoded form of a value: URL and form encoding (whose pattern also matches the value as
// typed, in any case), then base64 and base64url at every alignment.
const encodedEchoes = (value: string): EncodedEcho[] => [
  { form: 'uri', pattern: uriPattern(value) },
  { form: 'base64', pattern: base64Pattern(value, BASE64_ALPHABETS.base64) },
  { form: 'base64url', pattern: base64Pattern(value, BASE64_ALPHABETS.base64url) },
];

type Range = { readonly start: number; readonly end: number };

function occurrences(text: string, search: string): Range[] {
  const found: Range[] = [];
  if (search === '') return found;
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) {
    found.push({ start: index, end: index + search.length });
  }
  return found;
}

// Runs in `foldedText` that match the start of `foldedValue` for at least the minimum secret
// length: a value cut short, as a log line or a page that truncates a token would show it.
function prefixRuns(foldedText: string, foldedValue: string): Range[] {
  const runs: Range[] = [];
  const head = foldedValue.slice(0, MINIMUM_SECRET_LENGTH);
  if (head.length < MINIMUM_SECRET_LENGTH) return runs;
  for (let index = foldedText.indexOf(head); index !== -1; index = foldedText.indexOf(head, index + 1)) {
    let length = head.length;
    while (length < foldedValue.length && foldedText[index + length] === foldedValue[length]) length++;
    runs.push({ start: index, end: index + length });
    index += length - 1;
  }
  return runs;
}

function replaceRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  let kept = '';
  let position = 0;
  for (const range of sorted) {
    if (range.end <= position) continue;
    kept += text.slice(position, Math.max(range.start, position)) + SECRET_PLACEHOLDER;
    position = range.end;
  }
  return kept + text.slice(position);
}

// A function that replaces every echo of one value: its encoded forms, then the value in any case,
// then any prefix of it at least the minimum secret length long.
function valueRedaction(value: string): (text: string) => string {
  const echoes = encodedEchoes(value);
  const foldedValue = foldCase(value);
  return (text) => {
    let redacted = text;
    for (const echo of echoes) redacted = redacted.replace(echo.pattern, SECRET_PLACEHOLDER);
    redacted = replaceRanges(redacted, occurrences(foldCase(redacted), foldedValue));
    return replaceRanges(redacted, prefixRuns(foldCase(redacted), foldedValue));
  };
}

// A function that removes every echo of the given secrets from text, longest value first, so a
// longer secret is never left in part by a shorter one inside it. Secrets redacted by key are left
// out: their values are never searched for. With no secret to look for, text is unchanged.
export function secretRedaction(secrets: readonly Secret[]): (text: string) => string {
  const redactions = [...new Set(secrets.filter((secret) => redactionModeOf(secret) === 'value').map(reveal))]
    .sort((left, right) => right.length - left.length)
    .map(valueRedaction);
  if (redactions.length === 0) return (text) => text;
  return (text) => redactions.reduce((redacted, redact) => redact(redacted), text);
}

// A function that tells whether a whole text, such as what a failed check observed, is one of the
// given secrets redacted by key, in any case. Such a value is too short to search for inside longer
// text, but a text that is nothing but the value is an echo of it.
export function shortSecretMatch(secrets: readonly Secret[]): (text: string) => boolean {
  const values = new Set(secrets.filter((secret) => redactionModeOf(secret) === 'key-only').map((secret) => foldCase(reveal(secret).trim())));
  values.delete('');
  return (text) => values.size > 0 && values.has(foldCase(text.trim()));
}

// The forms in which `secret` echoes in `text`. A value in another case counts only when it does
// not also appear as typed, a URL or form encoding only when it differs from the value in more than
// case, and a prefix only when the whole value does not appear in any case. A value below the
// minimum length is not searched for, so it reports nothing.
export function echoFormsIn(text: string, secret: Secret): readonly LeakForm[] {
  const value = reveal(secret);
  if (value.length < MINIMUM_SECRET_LENGTH) return [];
  const foldedText = foldCase(text);
  const foldedValue = foldCase(value);
  const forms = new Set<LeakForm>();
  if (text.includes(value)) forms.add('raw');
  for (const echo of encodedEchoes(value)) {
    const found = text.match(echo.pattern) ?? [];
    const counts = echo.form === 'uri' ? found.some((match) => foldCase(match) !== foldedValue) : found.length > 0;
    if (counts) forms.add(echo.form);
  }
  const wholeInAnyCase = foldedText.includes(foldedValue);
  if (wholeInAnyCase && !forms.has('raw')) forms.add('case');
  if (!wholeInAnyCase && prefixRuns(foldedText, foldedValue).length > 0) forms.add('prefix');
  return [...forms];
}

// ---- Saved browser storage state ----------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const listIn = (record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] => {
  const value = record[key];
  return Array.isArray(value) ? value : [];
};

// The cookie and web-storage values inside saved storage state, each as a secret under the storage
// state's own name, so redaction removes them wherever a page echoes one. Storage state is JSON in
// the shape browsers export: { cookies: [{ value }], origins: [{ localStorage: [{ value }] }] }.
// Anything else in it is ignored here; the whole text is redacted as one value as well.
export function storageStateSecrets(storageState: Secret): readonly Secret[] {
  let parsed: unknown;
  try { parsed = JSON.parse(reveal(storageState)); } catch { return []; }
  if (!isRecord(parsed)) return [];
  const entries = [
    ...listIn(parsed, 'cookies'),
    ...listIn(parsed, 'origins').flatMap((origin) => (isRecord(origin) ? [...listIn(origin, 'localStorage'), ...listIn(origin, 'sessionStorage')] : [])),
  ];
  return entries.flatMap((entry) => {
    const value = isRecord(entry) ? entry['value'] : undefined;
    return typeof value === 'string' && value.length >= MINIMUM_SECRET_LENGTH ? [createSecret(storageState.name, value)] : [];
  });
}

// ---- Declared service calls -----------------------------------------------------------------------

// The header value a scheme makes of a secret, as an opaque Secret under the same name: bearer is
// "Bearer <value>", basic is "Basic " and the base64 of the value, which holds "user:password",
// and token and raw are the value as it is.
export function headerSecret(secret: Secret, scheme: HeaderScheme): Secret {
  switch (scheme) {
    case 'bearer': return createSecret(secret.name, `Bearer ${reveal(secret)}`);
    case 'basic': return createSecret(secret.name, `Basic ${Buffer.from(reveal(secret), 'utf8').toString('base64')}`);
    case 'token': case 'raw': return secret;
  }
}

// ---- Stubs and web storage --------------------------------------------------------------------

// A JSON text with each secret part written as a JSON string, as a stub's JSON body is served.
export const jsonTextWithSecrets = (body: JsonBodyWithSecrets): string =>
  body.jsonParts.map((part) => (typeof part === 'string' ? part : JSON.stringify(reveal(part)))).join('');

// A storage entry's value: a secret as it is, like any other string; anything else is the JSON text
// given, with its secret parts written as JSON strings.
export const storedTextWithSecrets = (value: Secret | JsonBodyWithSecrets): string =>
  (isSecret(value) ? reveal(value) : jsonTextWithSecrets(value));
