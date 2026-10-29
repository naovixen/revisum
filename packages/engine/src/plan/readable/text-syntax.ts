// Two-way syntax for the readable plan format. Each piece of syntax both reads a line of text into
// plain JSON and writes that JSON back as text. The readable grammar (plan-statements.ts) is built
// from these pieces only, so its reader and its writer are one description and cannot drift apart:
// what a piece writes, the same piece reads back as the same JSON. A piece that has no text for a
// value says so (undefined) rather than writing something that would read back differently.
//
// Reading works on one line at a time, from a 0-based index. Tokens are separated by one or more
// spaces. A failed reading says how far it got (`reach`); when several alternatives fail, the one
// that got furthest explains the line best.
// See docs/specs/SPEC-28-plan-authoring.md.

// Why readable text was refused. None of them carries a value from the text.
export type TextErrorCode = 'unknown-statement' | 'bad-locator' | 'bad-string' | 'bad-indent' | 'missing-header'
  | 'duplicate-header' | 'no-criterion' | 'unknown-key-name' | 'too-large' | 'duplicate-key'
  // Writing, not reading: the plan holds a construct the readable format has no form for, so it
  // stays JSON (readablePlanText).
  | 'no-readable-form';

// A place in readable text: a 1-based line and a 1-based column.
export type TextPosition = { readonly line: number; readonly column: number };

// A failed reading: the code and 1-based column to report, and the 0-based index reading got to.
export type TextFailure = { readonly code: TextErrorCode; readonly column: number; readonly reach: number };

// A successful reading also keeps the furthest failure met on the way, such as an optional part
// that was not there, so a later failure can be compared with it.
export type Reading<Value> =
  | { readonly ok: true; readonly value: Value; readonly next: number; readonly furthest: TextFailure | undefined }
  | { readonly ok: false; readonly failure: TextFailure };

// A value's syntax: how it is read from a line, and its text, or undefined when it has none.
export type Syntax = {
  readonly read: (line: string, index: number) => Reading<unknown>;
  readonly write: (value: unknown) => string | undefined;
};

type Fields = Record<string, unknown>;

// One part of an object's text, such as grammar words or one field. It reads into the object being
// built and writes from the object. `keys` are the fields it accounts for.
export type RecordPart = {
  readonly keys: readonly string[];
  readonly read: (line: string, index: number, into: Fields) => Reading<null>;
  readonly write: (fields: Readonly<Fields>) => string | undefined;
};

// One entry of a map-shaped field, such as an argument list: the entry's name (its key) and value.
export type EntrySyntax = {
  readonly read: (line: string, index: number) => Reading<{ readonly name: string; readonly value: unknown; readonly nameColumn: number }>;
  readonly write: (name: string, value: unknown) => string | undefined;
};

export const isRecord = (value: unknown): value is Readonly<Fields> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// True when two plain JSON values are the same, whatever the order of their keys.
export function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  if (isRecord(left)) {
    if (!isRecord(right) || Object.keys(left).length !== Object.keys(right).length) return false;
    return Object.keys(left).every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }
  return left === right;
}

// ---- Reading helpers ----------------------------------------------------------------------------

export const skipSpaces = (line: string, index: number): number => {
  let at = index;
  while (line[at] === ' ') at += 1;
  return at;
};

// A bare word is a run of characters other than space, quote, braces and comma.
const BARE_WORD_END = new Set([' ', '"', '{', '}', ',']);
const bareWordEnd = (line: string, start: number): number => {
  let at = start;
  while (at < line.length && !BARE_WORD_END.has(line[at] ?? ' ')) at += 1;
  return at;
};
const isBareWord = (value: unknown): value is string => typeof value === 'string' && /^[^ "{},]+$/.test(value);

// The bare word at `index`, after any spaces, and where it starts and ends; empty when there is none.
export function wordAt(line: string, index: number): { readonly word: string; readonly start: number; readonly end: number } {
  const start = skipSpaces(line, index);
  const end = bareWordEnd(line, start);
  return { word: line.slice(start, end), start, end };
}

// A line that is not the statement it was read as. A statement's own error is at column 1.
export const notThisStatement = (reach: number): TextFailure => ({ code: 'unknown-statement', column: 1, reach });
const refused = (failure: TextFailure): { readonly ok: false; readonly failure: TextFailure } => ({ ok: false, failure });
const read = <Value>(value: Value, next: number, furthest?: TextFailure): Reading<Value> => ({ ok: true, value, next, furthest });

// The failure that explains a line better: the one that got further, and at the same place a
// specific code rather than the general unknown-statement.
export function better(left: TextFailure | undefined, right: TextFailure | undefined): TextFailure | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left.reach !== right.reach) return left.reach > right.reach ? left : right;
  return left.code === 'unknown-statement' ? right : left;
}

// ---- Values -------------------------------------------------------------------------------------

// A bare word, copied as it is. The plan parser checks it against its pattern.
export const BARE: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    const end = bareWordEnd(line, start);
    return end === start ? refused(notThisStatement(start)) : read(line.slice(start, end), end);
  },
  write: (value) => (isBareWord(value) ? value : undefined),
};

// A URL or path, up to the next space. The parser keeps a URL percent-encoded, so it holds no space.
export const URL_WORD: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    const space = line.indexOf(' ', start);
    const end = space === -1 ? line.length : space;
    return end === start ? refused(notThisStatement(start)) : read(line.slice(start, end), end);
  },
  write: (value) => (typeof value === 'string' && value !== '' && !value.includes(' ') ? value : undefined),
};

// Quoted text: `\"` and `\\` are the only escapes, and the writer escapes every quote and backslash.
export const QUOTED: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    if (line[start] !== '"') return refused(notThisStatement(start));
    let text = '';
    for (let at = start + 1; at < line.length; at += 1) {
      const character = line[at] ?? '';
      if (character === '"') return read(text, at + 1);
      if (character === '\\') {
        const escaped = line[at + 1];
        if (escaped !== '"' && escaped !== '\\') return refused({ code: 'bad-string', column: at + 1, reach: at });
        text += escaped;
        at += 1;
      } else {
        text += character;
      }
    }
    // Never closed: the rest of the line is inside the string, so no other reading gets further.
    return refused({ code: 'bad-string', column: start + 1, reach: line.length });
  },
  write: (value) => (typeof value === 'string' ? `"${value.replace(/["\\]/g, '\\$&')}"` : undefined),
};

// A value reference, `{name}`: a value name in braces, with no spaces.
export const REFERENCE: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    if (line[start] !== '{') return refused(notThisStatement(start));
    const end = bareWordEnd(line, start + 1);
    if (end === start + 1 || line[end] !== '}') return refused({ code: 'bad-string', column: start + 1, reach: end });
    return read({ valueName: line.slice(start + 1, end) }, end + 1);
  },
  write(value) {
    if (!isRecord(value) || Object.keys(value).length !== 1 || !isBareWord(value['valueName'])) return undefined;
    return `{${value['valueName']}}`;
  },
};

// A number as JSON writes it, such as 2, -5, 0.5 or 1e+21.
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
export const NUMBER: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    const end = bareWordEnd(line, start);
    const word = line.slice(start, end);
    const value = Number(word);
    return JSON_NUMBER.test(word) && Number.isFinite(value) ? read(value, end) : refused(notThisStatement(start));
  },
  write: (value) => (typeof value === 'number' && Number.isFinite(value) ? JSON.stringify(value) : undefined),
};

// Digits only, such as the count of days in "3 days after today".
export const DIGITS: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    const end = bareWordEnd(line, start);
    const word = line.slice(start, end);
    return /^[0-9]+$/.test(word) ? read(Number(word), end) : refused(notThisStatement(start));
  },
  write: (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined),
};

// The line ends here: only spaces may follow.
export const END: RecordPart = {
  keys: [],
  read(line, index) {
    const at = skipSpaces(line, index);
    return at === line.length ? read(null, at) : refused(notThisStatement(at));
  },
  write: () => '',
};

// A construct the readable format has no form for, such as an unsafe plan feature: it never reads
// from text and never writes, so such a plan stays JSON. A table entry of this part is the explicit
// "no readable form" for its step, locator or check kind.
export const NO_READABLE_FORM: RecordPart = {
  keys: [],
  read: (_line, index) => refused(notThisStatement(index)),
  write: () => undefined,
};

// ---- Words --------------------------------------------------------------------------------------

// Grammar words, matched whole and case-insensitively, and written as given.
export function words(phrase: string): RecordPart {
  const expected = phrase.split(' ').map((word) => word.toLowerCase());
  return {
    keys: [],
    read(line, index) {
      let at = index;
      for (const word of expected) {
        const start = skipSpaces(line, at);
        const end = bareWordEnd(line, start);
        if (line.slice(start, end).toLowerCase() !== word) return refused(notThisStatement(start));
        at = end;
      }
      return read(null, at);
    },
    write: () => phrase,
  };
}

// One of several phrases, each standing for one JSON value. Longer phrases are tried first, so a
// phrase that starts another is never read in its place.
export function phrases(entries: readonly (readonly [unknown, string])[]): Syntax {
  const byLength = [...entries].sort(([, left], [, right]) => right.split(' ').length - left.split(' ').length);
  return {
    read(line, index) {
      let failure: TextFailure | undefined;
      for (const [value, phrase] of byLength) {
        const reading = words(phrase).read(line, index, {});
        if (reading.ok) return read(value, reading.next);
        failure = better(failure, reading.failure);
      }
      return refused(failure ?? notThisStatement(index));
    },
    write: (value) => entries.find(([candidate]) => sameJson(candidate, value))?.[1],
  };
}

// A table of words by the JSON value each stands for, such as a date format's words.
export const wordsFor = (table: Readonly<Record<string, string>>): Syntax => phrases(Object.entries(table));
// One of a list of names that are written as they are, such as roles.
export const oneOf = (values: readonly string[]): Syntax => phrases(values.map((value) => [value, value]));

// A word in its singular form when `amountKey` holds 1, and plural otherwise, such as "byte".
// Either form is read.
export function countedWord(amountKey: string, singular: string, plural: string): RecordPart {
  const forms = phrases([[singular, singular], [plural, plural]]);
  return {
    keys: [],
    read: (line, index) => {
      const reading = forms.read(line, index);
      return reading.ok ? read(null, reading.next) : reading;
    },
    write: (fields) => (fields[amountKey] === 1 ? singular : plural),
  };
}

// A unit such as "seconds", written in the singular ("1 second") when `amountKey` holds 1.
// `units` are the JSON values, each the plural of its word.
export function unitOf(key: string, amountKey: string, units: readonly string[]): RecordPart {
  const singular = (unit: string): string => unit.replace(/s$/, '');
  const forms = phrases(units.flatMap((unit) => [[unit, unit], [unit, singular(unit)]] as const));
  return {
    keys: [key],
    read(line, index, into) {
      const reading = forms.read(line, index);
      if (!reading.ok) return reading;
      into[key] = reading.value;
      return read(null, reading.next);
    },
    write(fields) {
      const unit = units.find((candidate) => candidate === fields[key]);
      if (unit === undefined) return undefined;
      return fields[amountKey] === 1 ? singular(unit) : unit;
    },
  };
}

// ---- Combining ----------------------------------------------------------------------------------

// The first alternative that reads the text, and the first that has text for the value.
export function choice(...alternatives: readonly Syntax[]): Syntax {
  return {
    read(line, index) {
      let failure: TextFailure | undefined;
      for (const alternative of alternatives) {
        const reading = alternative.read(line, index);
        if (reading.ok) return read(reading.value, reading.next, better(failure, reading.furthest));
        failure = better(failure, reading.failure);
      }
      return refused(failure ?? notThisStatement(index));
    },
    write(value) {
      for (const alternative of alternatives) {
        const text = alternative.write(value);
        if (text !== undefined) return text;
      }
      return undefined;
    },
  };
}

// The parts one after another, written with one space between them.
export function group(parts: readonly RecordPart[]): RecordPart {
  return {
    keys: parts.flatMap((part) => part.keys),
    read(line, index, into) {
      // Read into a scratch object, so a group that fails part way leaves nothing behind.
      const scratch: Fields = {};
      let at = index;
      let furthest: TextFailure | undefined;
      for (const part of parts) {
        const reading = part.read(line, at, scratch);
        if (!reading.ok) return refused(better(furthest, reading.failure) ?? reading.failure);
        at = reading.next;
        furthest = better(furthest, reading.furthest);
      }
      Object.assign(into, scratch);
      return read(null, at, furthest);
    },
    write(fields) {
      const pieces: string[] = [];
      for (const part of parts) {
        const piece = part.write(fields);
        if (piece === undefined) return undefined;
        if (piece !== '') pieces.push(piece);
      }
      return pieces.join(' ');
    },
  };
}

// An object written as its parts. It has text only when its fields are exactly the parts' fields,
// so no field is ever left out of the text.
export function record(parts: readonly RecordPart[]): Syntax {
  const whole = group(parts);
  return {
    read(line, index) {
      const into: Fields = {};
      const reading = whole.read(line, index, into);
      return reading.ok ? read(into, reading.next, reading.furthest) : reading;
    },
    write: (value) => (isRecord(value) && Object.keys(value).every((key) => whole.keys.includes(key)) ? whole.write(value) : undefined),
  };
}

// One field, read and written with `syntax`.
export function field(key: string, syntax: Syntax): RecordPart {
  return {
    keys: [key],
    read(line, index, into) {
      const reading = syntax.read(line, index);
      if (!reading.ok) return reading;
      into[key] = reading.value;
      return read(null, reading.next, reading.furthest);
    },
    write: (fields) => (Object.hasOwn(fields, key) ? syntax.write(fields[key]) : undefined),
  };
}

const copyOf = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A field whose value the words around it imply, such as an assertion's kind. It has no text.
export function constant(key: string, value: unknown): RecordPart {
  return {
    keys: [key],
    read(_line, index, into) {
      into[key] = copyOf(value);
      return read(null, index);
    },
    write: (fields) => (Object.hasOwn(fields, key) && sameJson(fields[key], value) ? '' : undefined),
  };
}

// Parts that are written only when their fields are present, and read only when their text is.
export function optional(...parts: readonly RecordPart[]): RecordPart {
  const inner = group(parts);
  return {
    keys: inner.keys,
    read(line, index, into) {
      const reading = inner.read(line, index, into);
      return reading.ok ? reading : read(null, index, reading.failure);
    },
    write: (fields) => (inner.keys.some((key) => Object.hasOwn(fields, key)) ? inner.write(fields) : ''),
  };
}

// A field that is `fallback` when its text is left out, such as a call's arguments: no text for
// the fallback, and the parts' text for any other value.
export function orElse(key: string, fallback: unknown, ...parts: readonly RecordPart[]): RecordPart {
  const inner = group(parts);
  return {
    keys: [...new Set([key, ...inner.keys])],
    read(line, index, into) {
      const reading = inner.read(line, index, into);
      if (reading.ok) return reading;
      into[key] = copyOf(fallback);
      return read(null, index, reading.failure);
    },
    write(fields) {
      if (!Object.hasOwn(fields, key)) return undefined;
      return sameJson(fields[key], fallback) ? '' : inner.write(fields);
    },
  };
}

// The first group of parts that reads the text, and the first that has text for the fields. A
// group is never written for fields another group accounts for, so no field is dropped.
export function either(...alternatives: readonly RecordPart[]): RecordPart {
  const keys = [...new Set(alternatives.flatMap((alternative) => alternative.keys))];
  return {
    keys,
    read(line, index, into) {
      let failure: TextFailure | undefined;
      for (const alternative of alternatives) {
        const reading = alternative.read(line, index, into);
        if (reading.ok) return read(null, reading.next, better(failure, reading.furthest));
        failure = better(failure, reading.failure);
      }
      return refused(failure ?? notThisStatement(index));
    },
    write(fields) {
      for (const alternative of alternatives) {
        if (keys.some((key) => !alternative.keys.includes(key) && Object.hasOwn(fields, key))) continue;
        const text = alternative.write(fields);
        if (text !== undefined) return text;
      }
      return undefined;
    },
  };
}

// A non-empty list, its items separated by `separator`: written ", " for a comma, " / " otherwise.
export function list(item: Syntax, separator = ','): Syntax {
  const joiner = separator === ',' ? ', ' : ` ${separator} `;
  return {
    read(line, index) {
      const first = item.read(line, index);
      if (!first.ok) return first;
      const items: unknown[] = [first.value];
      let at = first.next;
      let furthest = first.furthest;
      for (let next = skipSpaces(line, at); line[next] === separator; next = skipSpaces(line, at)) {
        const reading = item.read(line, next + 1);
        if (!reading.ok) return refused(better(furthest, reading.failure) ?? reading.failure);
        items.push(reading.value);
        at = reading.next;
        furthest = better(furthest, reading.furthest);
      }
      return read(items, at, furthest);
    },
    write(value) {
      if (!Array.isArray(value) || value.length === 0) return undefined;
      const pieces = value.map((entry) => item.write(entry));
      return pieces.every((piece) => piece !== undefined) ? pieces.join(joiner) : undefined;
    },
  };
}

// An entry of a map: `layout` places the entry's name, its value and any grammar words between them.
export function entry(layout: readonly (RecordPart | 'name' | 'value')[], value: Syntax): EntrySyntax {
  return {
    read(line, index) {
      let at = index;
      let name: string | undefined;
      let nameColumn = 0;
      let found: unknown;
      let furthest: TextFailure | undefined;
      for (const piece of layout) {
        if (piece === 'name') nameColumn = skipSpaces(line, at) + 1;
        const reading = piece === 'name' ? BARE.read(line, at) : piece === 'value' ? value.read(line, at) : piece.read(line, at, {});
        if (!reading.ok) return refused(better(furthest, reading.failure) ?? reading.failure);
        if (piece === 'name' && typeof reading.value === 'string') name = reading.value;
        if (piece === 'value') found = reading.value;
        at = reading.next;
        furthest = better(furthest, reading.furthest);
      }
      return name === undefined ? refused(notThisStatement(index)) : read({ name, value: found, nameColumn }, at, furthest);
    },
    write(name, entryValue) {
      const pieces = layout.map((piece) => (piece === 'name' ? BARE.write(name) : piece === 'value' ? value.write(entryValue) : piece.write({})));
      return pieces.every((piece) => piece !== undefined) ? pieces.filter((piece) => piece !== '').join(' ') : undefined;
    },
  };
}

// A non-empty map, its entries separated by commas, in their JSON order. A name given twice is
// duplicate-key at the second one: JSON cannot hold one key twice.
export function map(item: EntrySyntax): Syntax {
  return {
    read(line, index) {
      const entries: Fields = {};
      let at = index;
      let furthest: TextFailure | undefined;
      for (let next = index, first = true; first || line[next] === ','; next = skipSpaces(line, at), first = false) {
        const reading = item.read(line, first ? next : next + 1);
        if (!reading.ok) return refused(better(furthest, reading.failure) ?? reading.failure);
        const { name, value, nameColumn } = reading.value;
        // A duplicate is certain once read, so it outweighs any other failure on the line.
        if (Object.hasOwn(entries, name)) return refused({ code: 'duplicate-key', column: nameColumn, reach: line.length + 1 });
        entries[name] = value;
        at = reading.next;
        furthest = better(furthest, reading.furthest);
      }
      return read(entries, at, furthest);
    },
    write(value) {
      if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
      const pieces = Object.entries(value).map(([name, entryValue]) => item.write(name, entryValue));
      return pieces.every((piece) => piece !== undefined) ? pieces.join(', ') : undefined;
    },
  };
}

// The same syntax, with a failure inside it that names no specific problem reported as `code`
// at the place it starts, such as bad-locator for any locator that cannot be read.
export function reportedAs(code: TextErrorCode, syntax: Syntax): Syntax {
  const restate = (start: number, failure: TextFailure | undefined): TextFailure | undefined =>
    (failure?.code === 'unknown-statement' ? { code, column: start + 1, reach: failure.reach } : failure);
  return {
    read(line, index) {
      const start = skipSpaces(line, index);
      const reading = syntax.read(line, index);
      if (reading.ok) return read(reading.value, reading.next, restate(start, reading.furthest));
      return refused(restate(start, reading.failure) ?? reading.failure);
    },
    write: syntax.write,
  };
}
