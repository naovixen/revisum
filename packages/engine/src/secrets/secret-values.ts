// The engine's one module that reads secret values. It is on the reveal allow-list because
// redaction and leak scanning cannot work without the value: they look for it, and for each form
// in which it can echo, in text a run keeps or wrote. Everything here returns redacted text, forms
// found, a mode or a hash, never the value itself. A declared call's header scheme is applied here
// too, inside a new opaque Secret.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import {
  MINIMUM_SECRET_LENGTH, createSecret, reveal, type HeaderScheme, type LeakForm, type RedactionMode, type Secret,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';

// What replaces an echo of a secret in kept text.
export const SECRET_PLACEHOLDER = '[redacted:secret]';

// A base64 fragment shorter than this is too likely to occur by chance to count as an echo.
const MINIMUM_ENCODED_FRAGMENT_LENGTH = 12;

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

type EncodedEcho = { readonly form: 'raw' | 'uri' | 'base64' | 'base64url'; readonly text: string };

// The base64 text of `bytes` as it appears inside a longer encoded string, for each of the three
// alignments it can have there. Characters that also depend on neighbouring bytes are left out.
function encodedFragments(bytes: Buffer, encoding: 'base64' | 'base64url'): string[] {
  const fragments: string[] = [];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding);
    const start = offset === 0 ? 0 : 4;
    const end = Math.floor((offset + bytes.length) / 3) * 4;
    const fragment = encoded.slice(start, end);
    if (fragment.length >= MINIMUM_ENCODED_FRAGMENT_LENGTH) fragments.push(fragment);
  }
  return fragments;
}

// Every exact form of a value, longest first within each form, so the whole echo is replaced
// before any fragment of it.
function encodedEchoes(value: string): EncodedEcho[] {
  const bytes = Buffer.from(value, 'utf8');
  const echoes: EncodedEcho[] = [{ form: 'raw', text: value }];
  const uri = encodeURIComponent(value);
  if (uri !== value) echoes.push({ form: 'uri', text: uri });
  for (const encoding of ['base64', 'base64url'] as const) {
    echoes.push({ form: encoding, text: bytes.toString(encoding) });
    for (const fragment of encodedFragments(bytes, encoding)) echoes.push({ form: encoding, text: fragment });
  }
  return echoes;
}

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

// Replaces every echo of one value: its exact encoded forms, then the value in any case, then any
// prefix of it at least the minimum secret length long.
function redactValue(text: string, value: string): string {
  let redacted = text;
  for (const echo of encodedEchoes(value)) redacted = redacted.split(echo.text).join(SECRET_PLACEHOLDER);
  const foldedValue = foldCase(value);
  redacted = replaceRanges(redacted, occurrences(foldCase(redacted), foldedValue));
  return replaceRanges(redacted, prefixRuns(foldCase(redacted), foldedValue));
}

// A function that removes every echo of the given secrets from text. Secrets redacted by key are
// left out: their values are never searched for. With no secret to look for, text is unchanged.
export function secretRedaction(secrets: readonly Secret[]): (text: string) => string {
  const values = [...new Set(secrets.filter((secret) => redactionModeOf(secret) === 'value').map(reveal))]
    .sort((left, right) => right.length - left.length);
  if (values.length === 0) return (text) => text;
  return (text) => values.reduce(redactValue, text);
}

// The forms in which `secret` echoes in `text`. A value in another case counts only when it does
// not also appear as typed, and a prefix only when the whole value does not appear in any case.
// A value below the minimum length is not searched for, so it reports nothing.
export function echoFormsIn(text: string, secret: Secret): readonly LeakForm[] {
  const value = reveal(secret);
  if (value.length < MINIMUM_SECRET_LENGTH) return [];
  const forms = new Set<LeakForm>();
  for (const echo of encodedEchoes(value)) if (text.includes(echo.text)) forms.add(echo.form);
  const foldedText = foldCase(text);
  const foldedValue = foldCase(value);
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
