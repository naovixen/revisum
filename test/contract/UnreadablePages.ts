// The pages the negative check tests load: a healthy page of notes, two whose DOM functions throw
// with the element on screen, and one whose confirm dialog removes one element and hides another.
import type { FixtureRoute } from "#test-support/fixture-server.ts";

const htmlPage =
    (head: string, body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title>${head}</head><body><main>${body}</main></body></html>`,
    });

const SHOWN_NOTE = '<p data-testid="shown-note">Shown</p>';

export const NOTES_PATH = "/notes.html";
export const QUERY_THROWS_PATH = "/query-throws.html";
export const BOX_READ_THROWS_PATH = "/box-read-throws.html";
export const ANSWERED_DIALOG_PATH = "/answered-dialog.html";

export const UNREADABLE_PAGES: ReadonlyMap<string, FixtureRoute> = new Map([
    [NOTES_PATH, htmlPage("", `${SHOWN_NOTE}<p data-testid="hidden-note" hidden>Hidden</p>`)],
    [
        QUERY_THROWS_PATH,
        htmlPage(
            "<script>Document.prototype.querySelectorAll = function () { throw new Error('this page broke querySelectorAll'); };</script>",
            SHOWN_NOTE,
        ),
    ],
    [
        BOX_READ_THROWS_PATH,
        htmlPage(
            "<script>Element.prototype.getBoundingClientRect = function () { throw new Error('this page broke getBoundingClientRect'); };</script>",
            SHOWN_NOTE,
        ),
    ],
    [
        ANSWERED_DIALOG_PATH,
        htmlPage(
            "",
            `<button type="button" id="tidy">Tidy the notes</button>
             <p data-testid="removed-note">Removed once accepted</p>
             <p data-testid="hidden-note">Hidden once accepted</p>
             <script>
               document.getElementById('tidy').addEventListener('click', () => {
                 if (!window.confirm('Tidy the notes?')) return;
                 document.querySelector('[data-testid="removed-note"]').remove();
                 document.querySelector('[data-testid="hidden-note"]').hidden = true;
               });
             </script>`,
        ),
    ],
]);
