// The engine's one module that reads secret values. It is on the reveal allow-list because
// redaction and leak scanning cannot work without the value: they look for it, and for each form
// in which it can echo, in text a run keeps or wrote. Everything here returns redacted text, forms
// found, whether a text is a secret, a mode or a hash, never the value itself. A declared call's header scheme is applied here
// too, inside a new opaque Secret. The exceptions are what the browser itself must receive: a
// stub's body or a storage entry's value, written here with its secret arguments in place just
// before the run hands it to the driver, which never reports it back; and a recorded reply, whose
// secret echoes are cut out when it is recorded and put back from the replay's own store just
// before a replay hands the reply to the engine.
import {
  MINIMUM_SECRET_LENGTH, createSecret, isNonArrayObject, isSecret, reveal,
  type HeaderScheme, type JsonBodyWithSecrets, type LeakForm, type RedactionMode, type Secret, type SecretName,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';
import { normalise } from '../oracle.ts';
import {
  BASE64_ALPHABETS, base64Pattern, encodedEchoes, foldCase, fragmentRuns, mergedRanges, needsPieces, occurrences, percentEscapes,
  prefixRuns, uriWritings, wholeBase64Writings, wholeEncodedCharacters, writtenPattern, type EncodedEcho, type Range,
} from './EncodedEchoes.ts';
import { htmlWritings, jsonWritings } from './JsonWritings.ts';

// What replaces an echo of a secret in kept text.
export const SECRET_PLACEHOLDER = '[redacted:secret]';

// Short values are redacted by key: searching outputs for them would match ordinary text.
export const redactionModeOf = (secret: Secret): RedactionMode =>
  reveal(secret).length < MINIMUM_SECRET_LENGTH ? 'key-only' : 'value';

// Identifies a secret's content, such as a saved storage state, without revealing it.
export const secretSha256 = (secret: Secret): string => sha256(reveal(secret));

// ---- Finding and redacting echoes ------------------------------------------------------------------

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

// The text with every encoded echo of the value replaced. The pieces of a long value are all looked
// for in the text as it came, and what they cover goes as one: replacing them in turn could use up
// a piece's rightful place on another piece that repeats it, and leave part of the value behind. A
// part from its middle goes with them whole, or its ends could stay as too short to find afterwards.
function withoutEncodedEchoes(text: string, value: string, echoes: readonly EncodedEcho[], fragmentsIn: (foldedText: string) => readonly Range[]): string {
  if (needsPieces(value)) {
    return replaceRanges(text, mergedRanges([...echoes.flatMap((echo) => echo.rangesIn(text)), ...fragmentsIn(foldCase(text))]));
  }
  let redacted = text;
  for (const echo of echoes) {
    redacted = echo.withoutEchoes(redacted, SECRET_PLACEHOLDER);
  }
  return redacted;
}

// A function that replaces every echo of one value: its encoded forms, then the value in any case,
// then any prefix of it at least the minimum secret length long, and, for a long value, any part of
// it that long from anywhere within it. A search that cannot be built or run
// says nothing about what a text holds, so the whole text goes rather than a value that may be in it.
function valueRedaction(value: string): (text: string) => string {
  let echoes: readonly EncodedEcho[];
  try {
    echoes = encodedEchoes(value);
  } catch {
    return () => SECRET_PLACEHOLDER;
  }
  const foldedValue = foldCase(value);
  const fragmentsIn = needsPieces(value) ? fragmentRuns(foldedValue) : () => [];
  return (text) => {
    try {
      let redacted = withoutEncodedEchoes(text, value, echoes, fragmentsIn);
      redacted = replaceRanges(redacted, occurrences(foldCase(redacted), foldedValue));
      return replaceRanges(redacted, prefixRuns(foldCase(redacted), foldedValue));
    } catch {
      return SECRET_PLACEHOLDER;
    }
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
  const values = new Set(secrets.filter((secret) => redactionModeOf(secret) === 'key-only').map((secret) => foldCase(normalise(reveal(secret)))));
  values.delete('');
  return (text) => values.size > 0 && values.has(foldCase(normalise(text)));
}

// True when two texts are the same words: no encoding, only case and white space, between them.
const sameWords = (left: string, right: string): boolean => normalise(foldCase(left)) === normalise(foldCase(right));

// The forms in which `secret` echoes in `text`. A value in another case counts only when it does
// not also appear as typed, a written form (URL or form encoding, JSON escapes, HTML entities) only
// when it differs from the value in more than case and white space, and a prefix only when the whole
// value does not appear in any case. A value with its white space changed counts as typed: spacing
// is layout, not an encoding. A value below the minimum length is not searched for, so it reports
// nothing. A search that cannot be built or run has not shown the text is clean, so it reports a leak.
export function echoFormsIn(text: string, secret: Secret): readonly LeakForm[] {
  const value = reveal(secret);
  if (value.length < MINIMUM_SECRET_LENGTH) return [];
  try {
    return echoFormsOfValueIn(text, value);
  } catch {
    return ['raw'];
  }
}

function echoFormsOfValueIn(text: string, value: string): readonly LeakForm[] {
  const foldedText = foldCase(text);
  const foldedValue = foldCase(value);
  const forms = new Set<LeakForm>();
  if (text.includes(value)) forms.add('raw');
  let isRespaced = false;
  let hasItsWords = false;
  for (const echo of encodedEchoes(value)) {
    const found = echo.matchesIn(text);
    const isWritten = echo.form === 'uri' || echo.form === 'json' || echo.form === 'html';
    const counts = isWritten ? found.some((match) => !sameWords(match, echo.writes)) : found.length > 0;
    if (counts) forms.add(echo.form);
    const asWords = isWritten ? found.filter((match) => sameWords(match, echo.writes)) : [];
    hasItsWords ||= asWords.length > 0;
    isRespaced ||= asWords.some((match) => foldCase(match) !== foldCase(echo.writes));
  }
  if (isRespaced) {
    forms.add('raw');
  }
  const isInAnyCase = foldedText.includes(foldedValue);
  const wholeInAnyCase = isInAnyCase || isRespaced;
  if (isInAnyCase && !forms.has('raw')) {
    forms.add('case');
  }
  // Its words found while the whole value is not can only be one piece of a long value: a value cut short.
  const hasPartOfIt = hasItsWords || prefixRuns(foldedText, foldedValue).length > 0 || (needsPieces(value) && fragmentRuns(foldedValue)(foldedText).length > 0);
  if (!wholeInAnyCase && hasPartOfIt) forms.add('prefix');
  return [...forms];
}

// ---- Saved browser storage state ----------------------------------------------------------------

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
  if (!isNonArrayObject(parsed)) return [];
  const entries = [
    ...listIn(parsed, 'cookies'),
    ...listIn(parsed, 'origins').flatMap((origin) => (isNonArrayObject(origin) ? [...listIn(origin, 'localStorage'), ...listIn(origin, 'sessionStorage')] : [])),
  ];
  return entries.flatMap((entry) => {
    const value = isNonArrayObject(entry) ? entry['value'] : undefined;
    return typeof value === 'string' && value.length >= MINIMUM_SECRET_LENGTH ? [createSecret(storageState.name, value)] : [];
  });
}

// ---- Declared service calls -----------------------------------------------------------------------

// The header value a scheme makes of a secret, as an opaque Secret under the same name: bearer is
// "Bearer <value>", basic is "Basic " and the base64 of the value, which holds "user:password",
// and token and raw are the value as it is.
export function headerSecret(secret: Secret, scheme: HeaderScheme): Secret {
  switch (scheme) {
    case 'token': case 'raw': return secret;
    case 'bearer': case 'basic': {
      const made = createSecret(secret.name, headerValue(reveal(secret), scheme));
      HEADER_SOURCES.set(made, { source: secret, scheme });
      return made;
    }
  }
}

// The schemes that write a secret into a header value of its own.
export type WrappingScheme = 'bearer' | 'basic';

const headerValue = (value: string, scheme: WrappingScheme): string =>
  (scheme === 'bearer' ? `Bearer ${value}` : `Basic ${Buffer.from(value, 'utf8').toString('base64')}`);

// The secret each header value headerSecret made was made from, and the scheme that made it, so an
// echo of the bare value is cut from a recording too, and a replay can make the header value again
// from its own store.
const HEADER_SOURCES = new WeakMap<Secret, { readonly source: Secret; readonly scheme: WrappingScheme }>();

// ---- Recorded replies --------------------------------------------------------------------------------

// One echo of a secret cut out of a recorded reply, and how to put it back: at `offset` in the
// kept text, the value of the secret named, written in `form`. Nothing here is the value.
//   scheme: the echo was of the header value "Bearer <value>" or "Basic <base64>", not the value.
//   characters: for a prefix, how many of the value's characters were echoed.
//   spelling: for an echo written character by character, one letter per character when any is
//     not as typed: "." as typed, "u" or "l" upper- or lower-cased, "e" or "E" percent-escaped with
//     lower- or upper-case hex digits, "+" a space written as "+".
//   alignment: for a base64 echo, which of the three byte positions the value started at inside
//     the encoded text. Only the characters wholly decided by the value are cut; the partial ones
//     at each end stay in the kept text.
//   approximate: the echo was written in a way the fields above cannot describe, such as with JSON
//     escapes or HTML entities. It is cut all the same, and put back as typed, so the replay gives
//     another result and is never a pass.
export type SecretEcho = {
  readonly offset: number;
  readonly secretName: SecretName;
  readonly form: LeakForm;
  readonly scheme?: WrappingScheme;
  readonly characters?: number;
  readonly spelling?: string;
  readonly alignment?: number;
  readonly approximate?: true;
};

// A value searched for in a reply: a secret's own, or a header value made from it.
type EchoCandidate = { readonly secretName: SecretName; readonly value: string; readonly scheme?: WrappingScheme };

// What a reply's text becomes once every echo is cut out.
type CutText = { readonly kept: string; readonly echoes: readonly SecretEcho[] };

// One stretch of a reply's text: kept as it is, or an echo cut out of it.
type Piece = { readonly kept: string } | { readonly echo: Omit<SecretEcho, 'offset'> };

// The secrets and header values to search a reply for, longest value first, so a longer one is
// never left in part by a shorter one inside it. Values too short to search for are left out, as
// the redactor leaves them out.
function echoCandidates(secrets: readonly Secret[]): EchoCandidate[] {
  const candidates: EchoCandidate[] = [];
  for (const secret of secrets) {
    const made = HEADER_SOURCES.get(secret);
    if (made === undefined) {
      candidates.push({ secretName: secret.name, value: reveal(secret) });
    } else {
      candidates.push({ secretName: made.source.name, value: reveal(secret), scheme: made.scheme });
      candidates.push({ secretName: made.source.name, value: reveal(made.source) });
    }
  }
  const seen = new Set<string>();
  const distinct = candidates.filter((candidate) => {
    if (candidate.value.length < MINIMUM_SECRET_LENGTH || seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
  return distinct.sort((left, right) => right.value.length - left.value.length);
}

// How `echo` writes the first characters of `value`, one letter per character (see SecretEcho),
// or null when some character is written in another way.
function describeSpelling(echo: string, value: string): { readonly characters: number; readonly spelling: string } | null {
  let position = 0;
  let spelling = '';
  for (const character of value) {
    if (position >= echo.length) break;
    const rest = echo.slice(position);
    const escaped = percentEscapes(character);
    const upper = character.toUpperCase();
    const lower = character.toLowerCase();
    let written: { readonly letter: string; readonly text: string };
    if (rest.startsWith(character)) written = { letter: '.', text: character };
    else if (rest.startsWith(escaped)) written = { letter: 'e', text: escaped };
    else if (rest.startsWith(escaped.toUpperCase())) written = { letter: 'E', text: escaped.toUpperCase() };
    else if (character === ' ' && rest.startsWith('+')) written = { letter: '+', text: '+' };
    else if (upper.length === character.length && rest.startsWith(upper)) written = { letter: 'u', text: upper };
    else if (lower.length === character.length && rest.startsWith(lower)) written = { letter: 'l', text: lower };
    else return null;
    spelling += written.letter;
    position += written.text.length;
  }
  return position === echo.length ? { characters: spelling.length, spelling } : null;
}

// The first `characters` characters of `value`, written as `spelling` says (all as typed without one).
function spelled(value: string, characters: number, spelling: string | undefined): string {
  return [...value].slice(0, characters).map((character, index) => {
    switch (spelling?.[index] ?? '.') {
      case 'u': return character.toUpperCase();
      case 'l': return character.toLowerCase();
      case 'e': return percentEscapes(character);
      case 'E': return percentEscapes(character).toUpperCase();
      case '+': return '+';
      default: return character;
    }
  }).join('');
}

// The form a character-by-character echo of `value` takes, from its spelling.
function spellingForm(characters: number, spelling: string, value: string): LeakForm {
  if (characters < [...value].length) return 'prefix';
  if (/[eE+]/.test(spelling)) return 'uri';
  return /[ul]/.test(spelling) ? 'case' : 'raw';
}

// A character-by-character echo of `candidate`, described, or marked approximate.
function spellingEcho(echoed: string, candidate: EchoCandidate, prefix: boolean): Omit<SecretEcho, 'offset'> {
  const named = { secretName: candidate.secretName, ...(candidate.scheme === undefined ? {} : { scheme: candidate.scheme }) };
  const described = describeSpelling(echoed, candidate.value);
  if (described === null) {
    return prefix
      ? { ...named, form: 'prefix', characters: [...echoed].length, approximate: true }
      : { ...named, form: 'uri', approximate: true };
  }
  const form = spellingForm(described.characters, described.spelling, candidate.value);
  return {
    ...named, form,
    ...(form === 'prefix' ? { characters: described.characters } : {}),
    ...(/^\.*$/.test(described.spelling) ? {} : { spelling: described.spelling }),
  };
}

type Found = { readonly start: number; readonly end: number; readonly echo: Omit<SecretEcho, 'offset'> };

// The echoes of `candidate` in `text` in one form, in order and apart: its base64 or base64url
// forms first, then the value as typed, in another case or URL-encoded, then a prefix of it.
function echoesOf(text: string, candidate: EchoCandidate): Found[] {
  if (needsPieces(candidate.value)) {
    return echoesOfLongValue(text, candidate);
  }
  const named = { secretName: candidate.secretName, ...(candidate.scheme === undefined ? {} : { scheme: candidate.scheme }) };
  for (const form of ['base64', 'base64url'] as const) {
    const alphabet = BASE64_ALPHABETS[form];
    const found: Found[] = [];
    for (const match of text.matchAll(base64Pattern(candidate.value, alphabet))) {
      // The whole characters sit together inside the match; the alignment says which they are.
      for (const alignment of [0, 1, 2]) {
        const whole = wholeEncodedCharacters(candidate.value, alignment, alphabet);
        const at = match[0].indexOf(whole);
        if (whole === '' || at === -1) continue;
        found.push({ start: match.index + at, end: match.index + at + whole.length, echo: { ...named, form, alignment } });
        break;
      }
    }
    if (found.length > 0) return found;
  }
  const typed = [...text.matchAll(writtenPattern(candidate.value, uriWritings))]
    .map((match): Found => ({ start: match.index, end: match.index + match[0].length, echo: spellingEcho(match[0], candidate, false) }));
  if (typed.length > 0) return typed;
  // Put back as typed, not as it was written, so a replay of it gives another result and is no pass.
  for (const writings of [jsonWritings, htmlWritings]) {
    const form = writings === jsonWritings ? 'json' : 'html';
    const written = [...text.matchAll(writtenPattern(candidate.value, writings))]
      .map((match): Found => ({ start: match.index, end: match.index + match[0].length, echo: { ...named, form, approximate: true } }));
    if (written.length > 0) {
      return written;
    }
  }
  return prefixEchoes(text, candidate);
}

const prefixEchoes = (text: string, candidate: EchoCandidate): Found[] =>
  prefixRuns(foldCase(text), foldCase(candidate.value))
    .map((run): Found => ({ start: run.start, end: run.end, echo: spellingEcho(text.slice(run.start, run.end), candidate, true) }));

// The same search for a value too long for one pattern. Its base64 and the value as typed are found
// as plain text and go back exactly. What is left is found piece by piece, and goes back as the whole
// value typed, or for a part from its middle as a prefix as long, so a replay of it gives another
// result and is no pass.
function echoesOfLongValue(text: string, candidate: EchoCandidate): Found[] {
  const named = { secretName: candidate.secretName, ...(candidate.scheme === undefined ? {} : { scheme: candidate.scheme }) };
  for (const { form, alignment, written } of wholeBase64Writings(candidate.value)) {
    const found = occurrences(text, written);
    if (found.length > 0) {
      return found.map((range): Found => ({ ...range, echo: { ...named, form, alignment } }));
    }
  }
  const typed = occurrences(text, candidate.value);
  if (typed.length > 0) {
    return typed.map((range): Found => ({ ...range, echo: { ...named, form: 'raw' } }));
  }
  const echoes = encodedEchoes(candidate.value);
  for (const form of ['uri', 'json', 'html'] as const) {
    const covered = mergedRanges(echoes.filter((echo) => echo.form === form).flatMap((echo) => echo.rangesIn(text)));
    if (covered.length > 0) {
      return covered.map((range): Found => ({ ...range, echo: { ...named, form, approximate: true } }));
    }
  }
  const prefixes = prefixEchoes(text, candidate);
  if (prefixes.length > 0) {
    return prefixes;
  }
  return fragmentRuns(foldCase(candidate.value))(foldCase(text)).map((range): Found => ({
    ...range, echo: { ...named, form: 'prefix', characters: [...text.slice(range.start, range.end)].length, approximate: true },
  }));
}

// Cuts every echo of the given secrets out of a reply's text, in any form the leak scanner looks
// for, and says where each goes back. One form is found at a time, so the search repeats on what
// is left until nothing more is found. A search that cannot be built or run has not shown the text is
// clean, so all of it goes, leaving one echo a replay cannot match.
export function cutSecretEchoes(text: string, secrets: readonly Secret[]): CutText {
  const candidates = echoCandidates(secrets);
  try {
    return cutEchoesOf(text, candidates);
  } catch {
    const [first] = candidates;
    return first === undefined ? { kept: text, echoes: [] } : { kept: '', echoes: [{ offset: 0, secretName: first.secretName, form: 'raw', approximate: true }] };
  }
}

function cutEchoesOf(text: string, candidates: readonly EchoCandidate[]): CutText {
  let pieces: Piece[] = [{ kept: text }];
  for (const candidate of candidates) {
    for (let changed = true; changed;) {
      changed = false;
      pieces = pieces.flatMap((piece): Piece[] => {
        if (!('kept' in piece)) return [piece];
        const found = echoesOf(piece.kept, candidate);
        if (found.length === 0) return [piece];
        changed = true;
        const split: Piece[] = [];
        let position = 0;
        for (const echo of found) {
          if (echo.start < position) continue;
          split.push({ kept: piece.kept.slice(position, echo.start) }, { echo: echo.echo });
          position = echo.end;
        }
        split.push({ kept: piece.kept.slice(position) });
        return split;
      });
    }
  }
  let kept = '';
  const echoes: SecretEcho[] = [];
  for (const piece of pieces) {
    if ('kept' in piece) kept += piece.kept;
    else echoes.push({ offset: kept.length, ...piece.echo });
  }
  return { kept, echoes };
}

// The text one echo stood for, written again from `secret`'s value.
function echoText(echo: SecretEcho, secret: Secret): string {
  const value = echo.scheme === undefined ? reveal(secret) : headerValue(reveal(secret), echo.scheme);
  if (echo.form === 'base64' || echo.form === 'base64url') return wholeEncodedCharacters(value, echo.alignment ?? 0, BASE64_ALPHABETS[echo.form]);
  return spelled(value, echo.characters ?? [...value].length, echo.approximate === true ? undefined : echo.spelling);
}

// A recorded reply's text with each echo put back from `resolve`, the replay's own secret store.
// An echo whose secret the store does not hold is left out, so the replay gives another result.
// The echoes must be in offset order, each within the kept text, as cutSecretEchoes gives them.
export function restoreSecretEchoes(kept: string, echoes: readonly SecretEcho[], resolve: (name: SecretName) => Secret | null): string {
  let restored = '';
  let position = 0;
  for (const echo of echoes) {
    const secret = resolve(echo.secretName);
    restored += kept.slice(position, echo.offset) + (secret === null ? '' : echoText(echo, secret));
    position = echo.offset;
  }
  return restored + kept.slice(position);
}

// ---- Stubs and web storage --------------------------------------------------------------------

// A JSON text with each secret part written as a JSON string, as a stub's JSON body is served.
export const jsonTextWithSecrets = (body: JsonBodyWithSecrets): string =>
  body.jsonParts.map((part) => (typeof part === 'string' ? part : JSON.stringify(reveal(part)))).join('');

// A storage entry's value: a secret as it is, like any other string; anything else is the JSON text
// given, with its secret parts written as JSON strings.
export const storedTextWithSecrets = (value: Secret | JsonBodyWithSecrets): string =>
  (isSecret(value) ? reveal(value) : jsonTextWithSecrets(value));
