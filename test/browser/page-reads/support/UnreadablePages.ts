// The pages the negative check tests load: a healthy page of notes, two whose DOM functions throw
// with the element on screen, one whose script never lets go of its thread, so nothing can be read, and
// one whose confirm dialog removes one element and hides another.
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";

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
export const THREAD_HELD_PATH = "/thread-held.html";
export const ANSWERED_DIALOG_PATH = "/answered-dialog.html";
export const SLOW_LOAD_PATH = "/slow-load.html";
export const REMOVABLE_FRAME_PATH = "/removable-frame.html";
const REMOVABLE_FRAME_CONTENT_PATH = "/removable-frame-content.html";

// Longer than the step timeout of the tests that use it, so the page never finishes loading.
const SLOW_LOAD_PAUSE_MILLISECONDS = 10_000;

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
        THREAD_HELD_PATH,
        htmlPage(
            "",
            `${SHOWN_NOTE}
             <script>
               addEventListener('load', () => { setTimeout(() => { for (;;); }, 0); });
             </script>`,
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
    [
        SLOW_LOAD_PATH,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            chunks: [
                Buffer.from(
                    '<!doctype html><html lang="en"><head><title>Slow</title></head><body>',
                ),
                Buffer.from("<p>Loaded at last</p></body></html>"),
            ],
            chunkPauseMilliseconds: SLOW_LOAD_PAUSE_MILLISECONDS,
        }),
    ],
    [
        REMOVABLE_FRAME_PATH,
        htmlPage(
            "",
            `<iframe data-testid="removable-frame" title="Removable" src="${REMOVABLE_FRAME_CONTENT_PATH}" width="400" height="200"></iframe>`,
        ),
    ],
    [
        REMOVABLE_FRAME_CONTENT_PATH,
        htmlPage(
            "",
            `<button type="button" id="remove">Remove this frame</button>
             <script>
               document.getElementById('remove').addEventListener('click', () => frameElement.remove());
             </script>`,
        ),
    ],
]);
