/// <reference lib="dom" />
// What input does in the page besides its events.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// Focuses an element and selects its contents, ready for a fill.
export function focusAndSelect(element: HTMLInputElement): string {
    HTMLElement.prototype.focus.call(element);
    if (typeof element.select === "function") {
        element.select();
    }
    return "ok";
}

export function focusElement(element: HTMLElement): string {
    HTMLElement.prototype.focus.call(element);
    return "ok";
}

// Chooses the option of a select whose visible text, or else whose value, is `option`, and fires
// the input and change events a person's choice fires. Returns what SelectOutcome names.
export function selectOption(element: Element, option: string): string {
    const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();
    if (!(element instanceof HTMLSelectElement)) {
        return "not-a-select";
    }
    const options = Array.from(element.options);
    const chosen =
        options.find(
            (candidate) =>
                normalise(candidate.label === "" ? candidate.text : candidate.label) ===
                normalise(option),
        ) ?? options.find((candidate) => candidate.value === option);
    if (chosen === undefined) {
        return "no-option";
    }
    element.value = chosen.value;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return "selected";
}
