/// <reference lib="dom" />
// What a read of the whole page gives.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// The page's URL and title, and what its head says about it: every <meta> with a content and a
// name or property (once for each), and the resolved href of its canonical link, or null.
export function pageInfo(): string {
    const meta: { name: string; content: string }[] = [];
    for (const tag of Array.from(document.querySelectorAll("meta[content]"))) {
        const content = tag.getAttribute("content") ?? "";
        for (const attribute of ["name", "property"]) {
            const name = tag.getAttribute(attribute);
            if (name !== null && name !== "") {
                meta.push({ name, content });
            }
        }
    }
    const canonical = Array.from(document.querySelectorAll("link[href]")).find(
        (link) => link instanceof HTMLLinkElement && link.relList.contains("canonical"),
    );
    return JSON.stringify({
        url: location.href,
        title: document.title,
        meta,
        canonicalUrl: canonical instanceof HTMLLinkElement ? canonical.href : null,
    });
}

// The absolute URLs of the document's links, as JSON: every a and area element with an href, in
// document order, as the browser resolves each against the page's URL. Nothing is clicked or changed.
export function linkTargetList(): string {
    return JSON.stringify(Array.from(document.links).map((link) => link.href));
}

// The URL of the document this runs in: the browser's own internal one on its error page.
export function documentUrl(): string {
    return location.href;
}
