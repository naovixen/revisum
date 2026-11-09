// How to search a text for a value in every way it may have been written: URL and form encoding, JSON
// escapes, HTML entities and base64. Everything here works on plain text, so it needs no secret: the
// secret-values module reads the value and hands it here.
import { MINIMUM_SECRET_LENGTH } from "@revisum/contracts";
import { normalise } from "../run/outcome/Verdict.ts";
import { htmlWritings, jsonWritings } from "./JsonWritings.ts";

// Lower-cases each character whose lower-case form has the same length, so positions found in the
// folded text are positions in the original.
export function foldCase(text: string): string {
    let folded = "";
    for (const character of text) {
        const lower = character.toLowerCase();
        folded += lower.length === character.length ? lower : character;
    }
    return folded;
}

// The other ways a case change can write a value, when a character in it changes length with its
// case: "ß" upper-cases to "SS". foldCase leaves such a character alone to keep positions true, so a
// folded search cannot find these and each has to be looked for as a value of its own.
export function caseChangedSpellings(value: string): readonly string[] {
    const folded = foldCase(value);
    return [...new Set([value.toUpperCase(), value.toLowerCase()])].filter(
        (spelling) => foldCase(spelling) !== folded,
    );
}

export const escapeForPattern = (text: string): string =>
    text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

// ---- Written forms ------------------------------------------------------------------------------

// The white space that encoders write in ways a pattern has to know, so that a run of them can be
// matched in any of those ways.
const WHITE_SPACE_CHARACTERS: readonly string[] = [" ", "\t", "\n", "\r", " "];

// A pattern for the value with each character written as itself or in any of the ways `writings`
// gives, ignoring case: hex digits may be either case and a case-changed echo is caught too. A run
// of white space may be any other run, whichever way each is written: a page may lay out or collapse
// the spaces a secret holds, and the same words are the same secret.
export function writtenPattern(
    value: string,
    writings: (character: string) => readonly string[],
): RegExp {
    // In JSON a backslash written as itself is also the start of "\\", so a long run of them could be
    // divided in more ways than a regular expression can ever finish trying. The other forms' patterns
    // already match it as typed.
    const eachWay = (character: string): string =>
        (character === "\\" && writings === jsonWritings
            ? writings(character)
            : [escapeForPattern(character), ...writings(character)]
        ).join("|");
    const anyWhiteSpace = `(?:\\s|${WHITE_SPACE_CHARACTERS.flatMap((character) => writings(character)).join("|")})+`;
    const pieces = value
        .split(/(\s+)/)
        .filter((piece) => piece !== "")
        .map((piece) =>
            piece.trim() === ""
                ? anyWhiteSpace
                : [...piece].map((character) => `(?:${eachWay(character)})`).join(""),
        );
    return new RegExp(pieces.join(""), "gi");
}

// ---- URL and form encoding ------------------------------------------------------------------------

// The percent escapes of one character's UTF-8 bytes: "%2f" for "/".
export const percentEscapes = (character: string): string =>
    [...Buffer.from(character, "utf8")]
        .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
        .join("");

// How any URL or form encoder may write a character: as itself or percent-escaped, and a space also
// as "+", as forms and URLSearchParams write it. Encoders differ in which characters they escape
// (encodeURIComponent leaves "!" and "~" alone, URLSearchParams does not), so every character may take
// either form.
export const uriWritings = (character: string): readonly string[] =>
    character === " " ? [percentEscapes(character), "\\+"] : [percentEscapes(character)];

// ---- Base64 inside longer text ---------------------------------------------------------------------

export const BASE64_ALPHABETS = {
    base64: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
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
        if (knownBits !== 0) {
            characters.push({ knownBits, bits });
        }
    }
    return characters;
}

// A pattern for the value's base64 at each of the three alignments it can take inside a longer
// encoded text, with any padding when the value ends it. A character the value only partly decides
// matches every alphabet character that agrees on the value's bits, so all of the value's bits are
// checked: a near miss differs in some character and does not match, however short the value.
export function base64Pattern(value: string, alphabet: string): RegExp {
    const bytes = Buffer.from(value, "utf8");
    const alignments = [0, 1, 2].map((offset) => {
        const characters = encodedCharacters(bytes, offset).map(({ knownBits, bits }) => {
            const allowed = [...alphabet]
                .filter((character, index) => (index & knownBits) === bits)
                .map(escapeForPattern);
            return allowed.length === 1 ? allowed.join("") : `[${allowed.join("")}]`;
        });
        const padding = (offset + bytes.length) % 3 === 0 ? "" : "={0,2}";
        return `(?:${characters.join("")}${padding})`;
    });
    return new RegExp(alignments.join("|"), "g");
}

// The base64 characters wholly decided by `value` at `alignment`, in order, as `alphabet` writes them.
export function wholeEncodedCharacters(value: string, alignment: number, alphabet: string): string {
    return encodedCharacters(Buffer.from(value, "utf8"), alignment)
        .filter((character) => character.knownBits === 0b111111)
        .map((character) => alphabet[character.bits] ?? "")
        .join("");
}

// ---- Values too long for one pattern --------------------------------------------------------------

// A regular expression stops compiling a little past 5,000 characters of a secret, depending on what
// the secret holds, and says so only when first run. So a longer value is searched for in pieces, each
// well within that for any character.
const LONGEST_VALUE_FOR_ONE_PATTERN = 1_000;

export const needsPieces = (value: string): boolean => value.length > LONGEST_VALUE_FOR_ONE_PATTERN;

// A long value cut into pieces of nearly equal size, so none is short enough to match ordinary text,
// and at whole characters, so none splits one.
export function distinctPiecesOf(value: string): readonly string[] {
    const characters = [...value];
    const pieceCount = Math.ceil(characters.length / (LONGEST_VALUE_FOR_ONE_PATTERN / 2));
    const pieceLength = Math.ceil(characters.length / pieceCount);
    const pieces = Array.from({ length: pieceCount }, (piece, index) =>
        characters.slice(index * pieceLength, (index + 1) * pieceLength).join(""),
    );
    // A pattern matches a run of white space with any other, so a piece of nothing else would match
    // every space in every text.
    return [...new Set(pieces)].filter((piece) => piece.trim() !== "");
}

type Base64Form = "base64" | "base64url";
type WholeBase64Writing = {
    readonly form: Base64Form;
    readonly alignment: number;
    readonly written: string;
};

// A long value's base64 at each alignment, as plain text. Only the characters wholly decided by the
// value are looked for: patterns cut into pieces would each need a character two pieces share.
export const wholeBase64Writings = (value: string): readonly WholeBase64Writing[] =>
    (["base64", "base64url"] as const).flatMap((form) =>
        [0, 1, 2].map((alignment) => ({
            form,
            alignment,
            written: wholeEncodedCharacters(value, alignment, BASE64_ALPHABETS[form]),
        })),
    );

// ---- Finding echoes -------------------------------------------------------------------------------

export type Range = { readonly start: number; readonly end: number };

export function occurrences(text: string, search: string): Range[] {
    const found: Range[] = [];
    if (search === "") {
        return found;
    }
    for (
        let index = text.indexOf(search);
        index !== -1;
        index = text.indexOf(search, index + search.length)
    ) {
        found.push({ start: index, end: index + search.length });
    }
    return found;
}

// One way an encoded echo of a value may be written. `writes` is the text it writes: the whole value,
// or one piece of a value too long for a single pattern.
export type EncodedEcho = {
    readonly form: "uri" | "json" | "html" | Base64Form;
    readonly writes: string;
    readonly matchesIn: (text: string) => readonly string[];
    readonly withoutEchoes: (text: string, placeholder: string) => string;
    // Where it stands in the text, overlaps included.
    readonly rangesIn: (text: string) => readonly Range[];
};

// A piece of a value that repeats itself also matches off its own place. Scanning past each match
// could step over the place it really belongs, so every start is tried.
function overlappingMatches(text: string, pattern: RegExp): Range[] {
    const found: Range[] = [];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        found.push({ start: match.index, end: match.index + match[0].length });
        pattern.lastIndex = match.index + 1;
    }
    return found;
}

// The ranges as few apart as they can be: overlapping or touching ones become one, in order.
export function mergedRanges(ranges: readonly Range[]): readonly Range[] {
    const merged: Range[] = [];
    for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
        const last = merged.at(-1);
        if (last !== undefined && range.start <= last.end) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
        } else {
            merged.push(range);
        }
    }
    return merged;
}

const patternEcho = (form: EncodedEcho["form"], writes: string, pattern: RegExp): EncodedEcho => ({
    form,
    writes,
    matchesIn: (text) => text.match(pattern) ?? [],
    withoutEchoes: (text, placeholder) => text.replace(pattern, placeholder),
    rangesIn: (text) => overlappingMatches(text, pattern),
});

const literalEcho = (form: Base64Form, writes: string, written: string): EncodedEcho => ({
    form,
    writes,
    matchesIn: (text) => occurrences(text, written).map(() => written),
    withoutEchoes: (text, placeholder) => text.split(written).join(placeholder),
    rangesIn: (text) => occurrences(text, written),
});

const writtenEchoes = (value: string): readonly EncodedEcho[] => [
    patternEcho("uri", value, writtenPattern(value, uriWritings)),
    patternEcho("json", value, writtenPattern(value, jsonWritings)),
    patternEcho("html", value, writtenPattern(value, htmlWritings)),
];

// Every encoded form of a value: URL and form encoding, JSON escapes and HTML entities (whose
// patterns each also match the value as typed, in any case), then base64 and base64url at every
// alignment.
export function encodedEchoes(value: string): readonly EncodedEcho[] {
    if (needsPieces(value)) {
        return [
            ...distinctPiecesOf(value).flatMap(writtenEchoes),
            ...wholeBase64Writings(value).map(({ form, written }) =>
                literalEcho(form, value, written),
            ),
        ];
    }
    return [
        ...writtenEchoes(value),
        patternEcho("base64", value, base64Pattern(value, BASE64_ALPHABETS.base64)),
        patternEcho("base64url", value, base64Pattern(value, BASE64_ALPHABETS.base64url)),
    ];
}

const isWhiteSpace = (character: string | undefined): boolean =>
    character !== undefined && /\s/.test(character);

// Where the run at `start` in `foldedText` stops following `wanted`, the value in folded, normalised
// form: a run of white space in the value matches any run in the text, so a search neither misses a
// value the page has collapsed nor stops at the value's first word.
function endOfPrefixRun(foldedText: string, wanted: string, start: number): number {
    let position = start;
    let end = start;
    let matched = 0;
    while (matched < wanted.length && position < foldedText.length) {
        if (wanted[matched] === " ") {
            if (!isWhiteSpace(foldedText[position])) {
                break;
            }
            while (isWhiteSpace(foldedText[position])) {
                position++;
            }
        } else {
            if (foldedText[position] !== wanted[matched]) {
                break;
            }
            position++;
            end = position;
        }
        matched++;
    }
    return end;
}

// How many places in a long value a stretch of it is tried at. A value that repeats itself has a
// stretch in many places, and whichever is tried, what follows a run is searched for again.
const MOST_PLACES_TRIED = 8;

function longestRunFrom(
    foldedText: string,
    start: number,
    foldedValue: string,
    places: readonly number[],
): number {
    let end = start;
    for (const place of places) {
        let length = MINIMUM_SECRET_LENGTH;
        while (
            start + length < foldedText.length &&
            foldedText[start + length] === foldedValue[place + length]
        ) {
            length++;
        }
        end = Math.max(end, start + length);
    }
    return end;
}

// A function that finds the runs in a text that match a long value anywhere in it for at least the
// minimum secret length, in folded form: a part from the middle of the value, as a page that shows a
// long token in part would show it. A part under two pieces long may hold no whole piece, so looking
// for the pieces can miss it. Only for a value that needs pieces: a stretch of a shorter one is too
// likely to be an ordinary word.
export function fragmentRuns(foldedValue: string): (foldedText: string) => Range[] {
    const places = new Map<string, number[]>();
    for (let place = 0; place + MINIMUM_SECRET_LENGTH <= foldedValue.length; place++) {
        const stretch = foldedValue.slice(place, place + MINIMUM_SECRET_LENGTH);
        const known = places.get(stretch) ?? [];
        if (known.length < MOST_PLACES_TRIED) {
            places.set(stretch, [...known, place]);
        }
    }
    return (foldedText) => {
        const runs: Range[] = [];
        let start = 0;
        while (start + MINIMUM_SECRET_LENGTH <= foldedText.length) {
            const found = places.get(foldedText.slice(start, start + MINIMUM_SECRET_LENGTH));
            if (found === undefined) {
                start++;
            } else {
                const end = longestRunFrom(foldedText, start, foldedValue, found);
                runs.push({ start, end });
                start = end;
            }
        }
        return runs;
    };
}

// Runs in `foldedText` that match the start of `foldedValue` for at least the minimum secret
// length: a value cut short, as a log line or a page that truncates a token would show it.
export function prefixRuns(foldedText: string, foldedValue: string): Range[] {
    const runs: Range[] = [];
    const wanted = normalise(foldedValue);
    const head = wanted.slice(0, MINIMUM_SECRET_LENGTH);
    if (head.length < MINIMUM_SECRET_LENGTH) {
        return runs;
    }
    const headPattern = new RegExp(escapeForPattern(head).replace(/ /g, "\\s+"), "g");
    for (
        let found = headPattern.exec(foldedText);
        found !== null;
        found = headPattern.exec(foldedText)
    ) {
        const end = endOfPrefixRun(foldedText, wanted, found.index);
        runs.push({ start: found.index, end });
        headPattern.lastIndex = Math.max(end, found.index + 1);
    }
    return runs;
}
