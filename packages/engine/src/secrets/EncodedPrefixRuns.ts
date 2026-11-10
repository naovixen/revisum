// Finds a value cut short and then encoded, as a log line that truncates a token before escaping it
// writes one. The encoded echoes module finds whole values; a pattern for every possible length of
// a value would be far too large, so each search here finds the first minimum-length stretch and
// then follows the value one step at a time. Runs never overlap, so the work stays linear in the text.
import { MINIMUM_SECRET_LENGTH } from "@revisum/contracts";
import { mergedRanges, uriWritings, writtenPattern, type Range } from "./EncodedEchoes.ts";
import { htmlWritings, jsonWritings } from "./JsonWritings.ts";

type Writings = Parameters<typeof writtenPattern>[1];
type RunsIn = (text: string) => readonly Range[];

const isWhiteSpaceRun = (step: string): boolean => step.trim() === "";

// The value as the steps a written form follows: one per character, one per run of white space, as a
// written pattern treats them. White space at either end is layout, so it starts no echo.
const stepsOf = (value: string): readonly string[] =>
    value
        .trim()
        .split(/(\s+)/)
        .filter((piece) => piece !== "")
        .flatMap((piece) => (isWhiteSpaceRun(piece) ? [piece] : [...piece]));

function writtenPrefixRuns(steps: readonly string[], writings: Writings): RunsIn {
    const head = writtenPattern(steps.slice(0, MINIMUM_SECRET_LENGTH).join(""), writings);
    const rest = steps.slice(MINIMUM_SECRET_LENGTH);
    const stepPatterns = new Map(
        [...new Set(rest)].map((step) => [
            step,
            new RegExp(writtenPattern(step, writings).source, "iy"),
        ]),
    );
    const endOfRun = (text: string, headEnd: number): number => {
        let end = headEnd;
        let position = headEnd;
        for (const step of rest) {
            const pattern = stepPatterns.get(step);
            if (pattern === undefined) {
                break;
            }
            pattern.lastIndex = position;
            if (pattern.exec(text) === null) {
                break;
            }
            position = pattern.lastIndex;
            end = isWhiteSpaceRun(step) ? end : position;
        }
        return end;
    };
    return (text) => {
        const runs: Range[] = [];
        head.lastIndex = 0;
        for (let found = head.exec(text); found !== null; found = head.exec(text)) {
            const end = endOfRun(text, found.index + found[0].length);
            runs.push({ start: found.index, end });
            head.lastIndex = Math.max(end, found.index + 1);
        }
        return runs;
    };
}

// ---- Base64 ------------------------------------------------------------------------------------

const BASE64_CHARACTERS = /[A-Za-z0-9+/_-]+/g;
const BASE64_BITS_PER_CHARACTER = 6;
const BITS_PER_BYTE = 8;
// Six bits per character against eight per byte: a stretch of base64 lines up with whole bytes in
// one of four ways, depending on how many characters come before it.
const CHARACTER_SHIFTS = [0, 1, 2, 3];
const MOST_PADDING = 2;
const PADDING_CHARACTER = "=";

const characterHolding = (byte: number): number =>
    Math.floor((byte * BITS_PER_BYTE) / BASE64_BITS_PER_CHARACTER);
const charactersFor = (bytes: number): number =>
    Math.ceil((bytes * BITS_PER_BYTE) / BASE64_BITS_PER_CHARACTER);

function endOfMatchingBytes(decoded: Buffer, start: number, value: Buffer, from: number): number {
    let end = from;
    while (
        end < decoded.length &&
        end - start < value.length &&
        decoded[end] === value[end - start]
    ) {
        end++;
    }
    return end;
}

function paddingAfter(text: string, position: number): number {
    let padding = 0;
    while (padding < MOST_PADDING && text[position + padding] === PADDING_CHARACTER) {
        padding++;
    }
    return padding;
}

// Decoding compares every bit of the value's bytes at any alignment, and Node reads both base64
// alphabets, so this needs no pattern for each alignment and alphabet.
function base64PrefixRuns(value: Buffer, headLength: number): RunsIn {
    const head = value.subarray(0, headLength);
    return (text) => {
        const runs: Range[] = [];
        for (const match of text.matchAll(BASE64_CHARACTERS)) {
            const written = match[0];
            if (written.length < charactersFor(headLength)) {
                continue;
            }
            for (const shift of CHARACTER_SHIFTS) {
                const decoded = Buffer.from(written.slice(shift), "base64");
                let start = decoded.indexOf(head);
                while (start !== -1) {
                    const end = endOfMatchingBytes(decoded, start, value, start + headLength);
                    const charactersEnd = Math.min(shift + charactersFor(end), written.length);
                    const textEnd = match.index + charactersEnd;
                    runs.push({
                        start: match.index + shift + characterHolding(start),
                        end:
                            charactersEnd === written.length
                                ? textEnd + paddingAfter(text, textEnd)
                                : textEnd,
                    });
                    start = decoded.indexOf(head, end);
                }
            }
        }
        return runs;
    };
}

// A function that finds the runs in a text that hold the start of `value`, URL or form encoded, with
// JSON escapes, with HTML entities or in base64, for at least the minimum secret length. A value
// with fewer characters to follow than that has no prefix long enough to be told from ordinary text.
export function encodedPrefixRuns(value: string): RunsIn {
    const steps = stepsOf(value);
    if (steps.length < MINIMUM_SECRET_LENGTH) {
        return () => [];
    }
    const bytes = Buffer.from(value, "utf8");
    const head = Buffer.from([...value].slice(0, MINIMUM_SECRET_LENGTH).join(""), "utf8");
    const searches = [
        writtenPrefixRuns(steps, uriWritings),
        writtenPrefixRuns(steps, jsonWritings),
        writtenPrefixRuns(steps, htmlWritings),
        base64PrefixRuns(bytes, head.length),
    ];
    return (text) => mergedRanges(searches.flatMap((search) => search(text)));
}
