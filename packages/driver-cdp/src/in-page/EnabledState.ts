/// <reference lib="dom" />
// Whether an element can be used, for a read and for an action alike.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// What makes an element unusable, for a read and for an action alike, as ElementEnabledState names it:
// the browser's own :disabled, which knows fieldsets and their first legends, or aria-disabled. A custom
// element has no platform rule beyond that, so only its own disabled property can say more, and reading
// that runs the page's code: it is left to the caller, away from this script world and whatever it reads.
// One that is not upgraded yet has no code of its own to ask.
export function enabledState(element: Element): string {
    const isDisabled =
        Element.prototype.matches.call(element, ":disabled") ||
        Element.prototype.getAttribute.call(element, "aria-disabled") === "true";
    if (isDisabled) {
        return "disabled";
    }
    const isCustomElement =
        element instanceof HTMLElement &&
        Reflect.get(Element.prototype, "localName", element).includes("-") &&
        Element.prototype.matches.call(element, ":defined");
    return isCustomElement ? "custom-element" : "enabled";
}

// Called on a custom element, as `this`, in the page's own main world, so it calls nothing the page could
// have replaced. Only this one boolean leaves it. A disabled that is anything but false, or that throws,
// is not taken to mean enabled. One that reads undefined has said nothing against it, as one that is not
// there has not: an uninitialised reactive property of a component library reads so, and behaves as enabled.
export function isNotDisabledByItsProperty(this: Element): boolean {
    try {
        const disabled: unknown = (this as HTMLButtonElement).disabled;
        return disabled === false || disabled === undefined;
    } catch {
        return false;
    }
}
