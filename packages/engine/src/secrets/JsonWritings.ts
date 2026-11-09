// The ways JSON and HTML may write one character, as pieces of a regular expression, so that the leak
// scan and redaction know a secret however a serialiser or template has escaped it.

// No encoder writes an ASCII letter or digit as an escape, and leaving them out keeps the pattern
// for a long value small.
const isPlainCharacter = (character: string): boolean => /^[a-z0-9]$/i.test(character);

const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = {
    '"': '\\\\"',
    "\\": "\\\\\\\\",
    "/": "\\\\/",
    "\b": "\\\\b",
    "\f": "\\\\f",
    "\n": "\\\\n",
    "\r": "\\\\r",
    "\t": "\\\\t",
};

// How JSON may write a character: its short escape, and \uXXXX for each of its UTF-16 code units.
export function jsonWritings(character: string): readonly string[] {
    if (isPlainCharacter(character)) {
        return [];
    }
    let unicode = "";
    for (let index = 0; index < character.length; index++) {
        unicode += `\\\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    const short = JSON_SHORT_ESCAPES[character];
    return short === undefined ? [unicode] : [short, unicode];
}

// The names HTML gives printable ASCII characters, and the no-break space. A character outside
// ASCII is matched only by number: encoders write those as numbers, or leave them as they are.
const HTML_NAMES: Readonly<Record<string, readonly string[]>> = {
    "&": ["amp"],
    "<": ["lt"],
    ">": ["gt"],
    '"': ["quot"],
    "'": ["apos"],
    "\u00a0": ["nbsp"],
    "!": ["excl"],
    "#": ["num"],
    $: ["dollar"],
    "%": ["percnt"],
    "(": ["lpar"],
    ")": ["rpar"],
    "*": ["ast"],
    "+": ["plus"],
    ",": ["comma"],
    ".": ["period"],
    "/": ["sol"],
    ":": ["colon"],
    ";": ["semi"],
    "=": ["equals"],
    "?": ["quest"],
    "@": ["commat"],
    "[": ["lsqb", "lbrack"],
    "\\": ["bsol"],
    "]": ["rsqb", "rbrack"],
    "^": ["hat"],
    _: ["lowbar"],
    "`": ["grave"],
    "{": ["lcub", "lbrace"],
    "|": ["verbar", "vert"],
    "}": ["rcub", "rbrace"],
    "\n": ["newline"],
    "\t": ["tab"],
};

// How HTML may write a character: its entity names, and its code point in decimal or hex, with or
// without leading zeros. A browser reads a number with no closing ";" too.
export function htmlWritings(character: string): readonly string[] {
    if (isPlainCharacter(character)) {
        return [];
    }
    const codePoint = character.codePointAt(0) ?? 0;
    return [
        ...(HTML_NAMES[character] ?? []).map((name) => `&${name};`),
        `&#0*${codePoint.toString(10)};?`,
        `&#x0*${codePoint.toString(16)};?`,
    ];
}
