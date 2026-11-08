// The keys a press step can send, as Chromium's key events describe them, and what a key types with
// the modifier keys held.
import type { Key } from "@revisum/contracts";
import type { HeldModifierKey } from "./HeldModifierKeys.ts";

export type KeyDefinition = {
    readonly key: string;
    readonly code: string;
    readonly keyCode: number;
    readonly text?: string;
};
// Letters, digits and function keys follow the US keyboard layout's key codes, as Chromium expects.
const letterKey = (letter: string): KeyDefinition => ({
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    keyCode: letter.toUpperCase().charCodeAt(0),
    text: letter,
});
const digitKey = (digit: string): KeyDefinition => ({
    key: digit,
    code: `Digit${digit}`,
    keyCode: digit.charCodeAt(0),
    text: digit,
});
const FIRST_FUNCTION_KEY_CODE = 112;
const functionKey = (number: number): KeyDefinition => ({
    key: `F${number}`,
    code: `F${number}`,
    keyCode: FIRST_FUNCTION_KEY_CODE + number - 1,
});
export const KEY_DEFINITIONS: { readonly [Name in Key]: KeyDefinition } = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    "a": letterKey("a"),
    "b": letterKey("b"),
    "c": letterKey("c"),
    "d": letterKey("d"),
    "e": letterKey("e"),
    "f": letterKey("f"),
    "g": letterKey("g"),
    "h": letterKey("h"),
    "i": letterKey("i"),
    "j": letterKey("j"),
    "k": letterKey("k"),
    "l": letterKey("l"),
    "m": letterKey("m"),
    "n": letterKey("n"),
    "o": letterKey("o"),
    "p": letterKey("p"),
    "q": letterKey("q"),
    "r": letterKey("r"),
    "s": letterKey("s"),
    "t": letterKey("t"),
    "u": letterKey("u"),
    "v": letterKey("v"),
    "w": letterKey("w"),
    "x": letterKey("x"),
    "y": letterKey("y"),
    "z": letterKey("z"),
    "0": digitKey("0"),
    "1": digitKey("1"),
    "2": digitKey("2"),
    "3": digitKey("3"),
    "4": digitKey("4"),
    "5": digitKey("5"),
    "6": digitKey("6"),
    "7": digitKey("7"),
    "8": digitKey("8"),
    "9": digitKey("9"),
    Backquote: { key: "`", code: "Backquote", keyCode: 192, text: "`" },
    Minus: { key: "-", code: "Minus", keyCode: 189, text: "-" },
    Equal: { key: "=", code: "Equal", keyCode: 187, text: "=" },
    BracketLeft: { key: "[", code: "BracketLeft", keyCode: 219, text: "[" },
    BracketRight: { key: "]", code: "BracketRight", keyCode: 221, text: "]" },
    Backslash: { key: "\\", code: "Backslash", keyCode: 220, text: "\\" },
    Semicolon: { key: ";", code: "Semicolon", keyCode: 186, text: ";" },
    Quote: { key: "'", code: "Quote", keyCode: 222, text: "'" },
    Comma: { key: ",", code: "Comma", keyCode: 188, text: "," },
    Period: { key: ".", code: "Period", keyCode: 190, text: "." },
    Slash: { key: "/", code: "Slash", keyCode: 191, text: "/" },
    "F1": functionKey(1),
    "F2": functionKey(2),
    "F3": functionKey(3),
    "F4": functionKey(4),
    "F5": functionKey(5),
    "F6": functionKey(6),
    "F7": functionKey(7),
    "F8": functionKey(8),
    "F9": functionKey(9),
    "F10": functionKey(10),
    "F11": functionKey(11),
    "F12": functionKey(12),
};
// The modifier keys, as the left-hand key of each pair, and the bit each sets in the protocol's
// modifiers mask, which tells the page which keys are held.
export const MODIFIER_KEY_DEFINITIONS: {
    readonly [Name in HeldModifierKey]: KeyDefinition & { readonly bit: number };
} = {
    Alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
    Control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
    Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
    Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
};
// The protocol's location for the left-hand key of a pair.
export const LEFT_KEY = 1;
export const modifierMask = (held: readonly HeldModifierKey[]): number =>
    held.reduce((mask, modifier) => mask | MODIFIER_KEY_DEFINITIONS[modifier].bit, 0);

// What the US keyboard layout types for a key pressed with Shift, where it differs from the key.
const SHIFTED_TEXT: Readonly<Record<string, string>> = {
    "`": "~",
    "1": "!",
    "2": "@",
    "3": "#",
    "4": "$",
    "5": "%",
    "6": "^",
    "7": "&",
    "8": "*",
    "9": "(",
    "0": ")",
    "-": "_",
    "=": "+",
    "[": "{",
    "]": "}",
    "\\": "|",
    ";": ":",
    "'": '"',
    ",": "<",
    ".": ">",
    "/": "?",
};

// The key as pressed with the held modifiers. With Alt, Control or Meta held it types nothing, as a
// keyboard shortcut does not; with Shift alone it types its shifted character.
export function heldKeyDefinition(
    definition: KeyDefinition,
    held: readonly HeldModifierKey[],
): KeyDefinition {
    if (held.some((modifier) => modifier !== "Shift")) {
        return { key: definition.key, code: definition.code, keyCode: definition.keyCode };
    }
    if (!held.includes("Shift") || definition.text === undefined) {
        return definition;
    }
    const shifted =
        SHIFTED_TEXT[definition.text] ??
        (/^[a-z]$/.test(definition.text) ? definition.text.toUpperCase() : definition.text);
    return {
        ...definition,
        key: definition.text === definition.key ? shifted : definition.key,
        text: shifted,
    };
}
