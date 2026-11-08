/// <reference lib="dom" />
// The run's clipboard.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// The run's clipboard as plain text, line endings normalised to "\n", cut after
// maximumCharacters + 1 characters. Called in an isolated world, only while the driver holds the
// clipboard-read permission, so the page's own scripts never see the read.
export async function readClipboardText(maximumCharacters: number): Promise<string> {
    const text = await navigator.clipboard.readText();
    return text.replace(/\r\n?/g, "\n").slice(0, maximumCharacters + 1);
}
