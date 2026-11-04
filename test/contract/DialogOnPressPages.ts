// The pages of the tests on a click check left behind by a dialog. Each has a button that opens a dialog
// during a press, and a button that counts the clicks the browser sends it.
import type { FixtureRoute } from "#test-support/fixture-server.ts";

export const ASK = "ask";
export const BUTTON = "save";
export const TALLY = "tally";
export const SHOWN = "shown";
export const FRAME = "inner";
export const LINK = "link";
export const FIELD = "field";
export const CHECKBOX = "checkbox";
export const FIRST_RADIO = "first-radio";
export const PAGE_CLICKER = "page-clicker";

export const SUBMITTED = "submitted";
export const TICKED = "ticked";
export const SECOND_RADIO_CHOSEN = "second radio chosen";
export const PAGE_BUTTON_CLICKED = "page button clicked";
export const HOVERED = "hovered";
export const TYPED_TEXT = "hello";

const htmlRoute =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>${body}</body></html>`,
    });

const pageWith = (askScript: string, moreControls = "", moreScript = ""): FixtureRoute =>
    htmlRoute(`
      <p data-testid="${TALLY}">0</p>
      <main>
        <button type="button" data-testid="${ASK}">Ask</button>
        <button type="button" data-testid="${BUTTON}">Save</button>
        ${moreControls}
      </main>
      <div id="cover" style="display:none;position:fixed;inset:0"></div>
      <script>
        let clicks = 0;
        const ask = document.querySelector('[data-testid="${ASK}"]');
        const button = document.querySelector('[data-testid="${BUTTON}"]');
        const cover = document.getElementById('cover');
        button.addEventListener('click', (event) => {
          if (!event.isTrusted) return;
          clicks += 1;
          document.querySelector('[data-testid="${TALLY}"]').textContent = String(clicks);
        });
        ${askScript}
        ${moreScript}
      </script>`);

const opensDialogAt = (eventType: string): string =>
    `ask.addEventListener('${eventType}', () => { alert('Are you sure?'); });`;
const COVER_ARRIVES_WITH_THE_POINTER_OVER_THE_BUTTON = `button.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });`;

const CONTROLS = `
  <p data-testid="${SHOWN}">nothing</p>
  <a data-testid="${LINK}" href="#followed">Go on</a>
  <form id="form">
    <input data-testid="${FIELD}" aria-label="Field">
    <button type="submit">Send</button>
  </form>
  <label>Tick <input type="checkbox" id="tick" data-testid="${CHECKBOX}"></label>
  <label>First <input type="radio" name="choice" data-testid="${FIRST_RADIO}" checked></label>
  <label>Second <input type="radio" name="choice" id="second-radio"></label>
  <button type="button" data-testid="${PAGE_CLICKER}">Makes the page click</button>
  <button type="button" id="page-button">The button the page clicks</button>`;
const CONTROLS_SCRIPT = `
  const show = (shown) => { document.querySelector('[data-testid="${SHOWN}"]').textContent = shown; };
  const pageButton = document.getElementById('page-button');
  document.getElementById('form').addEventListener('submit', (event) => { event.preventDefault(); show('${SUBMITTED}'); });
  document.getElementById('tick').addEventListener('change', () => { show('${TICKED}'); });
  document.getElementById('second-radio').addEventListener('change', () => { show('${SECOND_RADIO_CHOSEN}'); });
  document.querySelector('[data-testid="${FIELD}"]').addEventListener('input', (event) => { show(event.target.value); });
  pageButton.addEventListener('click', () => { show('${PAGE_BUTTON_CLICKED}'); });
  document.querySelector('[data-testid="${PAGE_CLICKER}"]').addEventListener('keydown', () => { pageButton.click(); });
  button.addEventListener('mouseover', () => { show('${HOVERED}'); });`;

export const CONTROLS_PAGE = "/controls.html";
export const DIALOG_AT_POINTERDOWN_PAGE = "/dialog-at-pointerdown.html";
export const DIALOG_AT_MOUSEDOWN_PAGE = "/dialog-at-mousedown.html";
export const COVERED_AFTER_DIALOG_PAGE = "/covered-after-dialog.html";

export const framing = (framedPage: string): string => `/framing${framedPage}`;
// The top document has buttons and a tally of its own, under the same test ids as the frame's.
const framingPage = (framedPage: string): FixtureRoute =>
    pageWith(
        opensDialogAt("pointerdown"),
        `<iframe data-testid="${FRAME}" title="Inner" src="${framedPage}" style="width:600px;height:300px;border:0"></iframe>`,
    );

// Pages where an element answers to the name the driver's click check once kept on its own window.
export const ADDER = "adder";
const NAME_OF_THE_CLICK_CHECK = "armedHitCheck";
const NAMED_BY_ID = `<div id="${NAME_OF_THE_CLICK_CHECK}"></div>`;
const NAMED_BY_FORM = `<form name="${NAME_OF_THE_CLICK_CHECK}"><input name="disarm" aria-label="Disarm"></form>`;
const NAMED_BY_FRAME = `<iframe name="${NAME_OF_THE_CLICK_CHECK}" title="Named" src="about:blank" style="width:20px;height:20px"></iframe>`;
const ADDS_THE_NAMED_ELEMENT = `document.body.append(Object.assign(document.createElement('div'), { id: '${NAME_OF_THE_CLICK_CHECK}' }));`;

export const NAMED_BY_ID_PAGE = "/named-by-id.html";
export const NAMED_BY_FORM_PAGE = "/named-by-form.html";
export const NAMED_BY_FRAME_PAGE = "/named-by-frame.html";
export const NAMED_AT_LOAD_PAGE = "/named-at-load.html";
export const NAMED_AFTER_A_CLICK_PAGE = "/named-after-a-click.html";
export const NAMED_AND_COVERED_PAGE = "/named-and-covered.html";
export const NAMED_AND_ASKING_PAGE = "/named-and-asking.html";

export const DIALOG_ON_PRESS_PAGES = new Map<string, FixtureRoute>([
    [
        NAMED_BY_ID_PAGE,
        pageWith("", `${NAMED_BY_ID}<input data-testid="${FIELD}" aria-label="Field">`),
    ],
    [NAMED_BY_FORM_PAGE, pageWith("", NAMED_BY_FORM)],
    [NAMED_BY_FRAME_PAGE, pageWith("", NAMED_BY_FRAME)],
    [NAMED_AT_LOAD_PAGE, pageWith("", "", ADDS_THE_NAMED_ELEMENT)],
    [
        NAMED_AFTER_A_CLICK_PAGE,
        pageWith(
            "",
            `<button type="button" data-testid="${ADDER}">Add</button>`,
            `document.querySelector('[data-testid="${ADDER}"]').addEventListener('click', () => { ${ADDS_THE_NAMED_ELEMENT} });`,
        ),
    ],
    [
        NAMED_AND_COVERED_PAGE,
        pageWith("", NAMED_BY_ID, COVER_ARRIVES_WITH_THE_POINTER_OVER_THE_BUTTON),
    ],
    [NAMED_AND_ASKING_PAGE, pageWith(opensDialogAt("pointerdown"), NAMED_BY_ID)],
    [framing(NAMED_BY_ID_PAGE), framingPage(NAMED_BY_ID_PAGE)],
    [CONTROLS_PAGE, pageWith(opensDialogAt("pointerdown"), CONTROLS, CONTROLS_SCRIPT)],
    [DIALOG_AT_POINTERDOWN_PAGE, pageWith(opensDialogAt("pointerdown"))],
    [DIALOG_AT_MOUSEDOWN_PAGE, pageWith(opensDialogAt("mousedown"))],
    [
        COVERED_AFTER_DIALOG_PAGE,
        pageWith(opensDialogAt("pointerdown"), "", COVER_ARRIVES_WITH_THE_POINTER_OVER_THE_BUTTON),
    ],
    [framing(DIALOG_AT_POINTERDOWN_PAGE), framingPage(DIALOG_AT_POINTERDOWN_PAGE)],
    [framing(COVERED_AFTER_DIALOG_PAGE), framingPage(COVERED_AFTER_DIALOG_PAGE)],
]);
