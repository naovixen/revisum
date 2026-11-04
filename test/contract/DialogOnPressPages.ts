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

// Pages where a form's input answers to the name of a method the click check calls on that form, because
// the browser exposes a form's named inputs as properties of the form.
export const CLICKED_FORM = "clicked-form";
export const NOTHING_SHOWN = "nothing";
export const COVER_CLICKED = "cover clicked";

const FORM_CONTROLS = `
  <p data-testid="${SHOWN}">${NOTHING_SHOWN}</p>
  <input data-testid="${FIELD}" aria-label="Field">`;
const show = (shown: string): string =>
    `document.querySelector('[data-testid="${SHOWN}"]').textContent = ${shown};`;
const FORM_CONTROLS_SCRIPT = `
  document.querySelector('[data-testid="${FIELD}"]').addEventListener('input', (event) => { ${show("event.target.value")} });
  button.addEventListener('mouseover', () => { ${show(`'${HOVERED}'`)} });`;
// The form's own method may be the one the input hides, so the page does not call it.
const FORM_OPENS_DIALOG_AT_POINTERDOWN = `EventTarget.prototype.addEventListener.call(document.querySelector('[data-testid="${CLICKED_FORM}"]'), 'pointerdown', () => { alert('Are you sure?'); });`;

const clickedForm = (inputAttributes: string): string =>
    `<form data-testid="${CLICKED_FORM}" style="padding:40px;border:1px solid"><input ${inputAttributes} aria-label="Named"></form>`;

export const formHoldingInputPage = (inputName: string): string =>
    `/form-holding-input-${inputName}.html`;
export const askingFormHoldingInputPage = (inputName: string): string =>
    `/asking-form-holding-input-${inputName}.html`;

const formHoldingInputRoutes = (inputName: string): readonly [string, FixtureRoute][] => {
    const controls = `${FORM_CONTROLS}${clickedForm(`name="${inputName}"`)}`;
    return [
        [formHoldingInputPage(inputName), pageWith("", controls, FORM_CONTROLS_SCRIPT)],
        [
            askingFormHoldingInputPage(inputName),
            pageWith(FORM_OPENS_DIALOG_AT_POINTERDOWN, controls, FORM_CONTROLS_SCRIPT),
        ],
    ];
};

export const FORM_INPUT_NAME_HIDING_NOTHING = "plain";
export const FORM_INPUT_NAMES_HIDING_A_LISTENER_METHOD = [
    "removeEventListener",
    "addEventListener",
];

// Every name the driver's in-page functions read on an element, which a form's input can take from it.
export const FORM_INPUT_NAMES_HIDING_WHAT_THE_DRIVER_READS = [
    "assignedSlot",
    "classList",
    "children",
    "closest",
    "disabled",
    "elements",
    "focus",
    "form",
    "getAttribute",
    "getBoundingClientRect",
    "getClientRects",
    "getRootNode",
    "innerText",
    "isConnected",
    "matches",
    "ownerDocument",
    "parentElement",
    "parentNode",
    "querySelectorAll",
    "scrollIntoView",
    "shadowRoot",
    "tagName",
    "textContent",
];

export const BUTTON_IN_THE_FORM = "button-in-the-form";
export const BUTTON_IN_THE_FORM_NAME = "Inside the form";
export const FORM_LABEL = "Order form";
export const FORM_SUBMIT_NAME = "Send order";
export const BUTTON_IN_THE_FORM_CLICKED = "the button in the form was clicked";

export const formHoldingButtonPage = (inputName: string): string =>
    `/form-holding-a-button-and-input-${inputName}.html`;
export const formWithSubmitPage = (inputName: string): string =>
    `/form-with-a-submit-and-input-${inputName}.html`;

const formHoldingButtonRoute = (inputName: string): [string, FixtureRoute] => [
    formHoldingButtonPage(inputName),
    pageWith(
        "",
        `<p data-testid="${SHOWN}">${NOTHING_SHOWN}</p>
         <form data-testid="${CLICKED_FORM}" aria-label="${FORM_LABEL}" style="padding:40px;border:1px solid">
           <input name="${inputName}" aria-label="Named">
           <button type="button" data-testid="${BUTTON_IN_THE_FORM}">${BUTTON_IN_THE_FORM_NAME}</button>
         </form>`,
        `document.querySelector('[data-testid="${BUTTON_IN_THE_FORM}"]').addEventListener('click', () => { ${show(`'${BUTTON_IN_THE_FORM_CLICKED}'`)} });`,
    ),
];
const formWithSubmitRoute = (inputName: string): [string, FixtureRoute] => [
    formWithSubmitPage(inputName),
    pageWith(
        "",
        `<form><input name="${inputName}" data-testid="${FIELD}" aria-label="Named"><button type="submit">${FORM_SUBMIT_NAME}</button></form>`,
    ),
];

const COVERING_FORM_ID = "covering-form";
const coveringFormPage = (hiddenInputName: string, onCoverClick: string): FixtureRoute =>
    pageWith(
        "",
        `<p data-testid="${SHOWN}">${NOTHING_SHOWN}</p>
         <form id="${COVERING_FORM_ID}" style="display:none;position:fixed;inset:0"><input type="hidden" name="${hiddenInputName}"></form>`,
        `const coveringForm = document.getElementById('${COVERING_FORM_ID}');
         coveringForm.addEventListener('click', () => { ${show(`'${COVER_CLICKED}'`)} ${onCoverClick} });
         button.addEventListener('mousemove', () => { coveringForm.style.display = 'block'; }, { once: true });`,
    );
const REMOVES_THE_BUTTON = "button.remove();";

export const COVER_REMOVING_THE_BUTTON_HOLDING_CLOSEST_PAGE =
    "/cover-removing-the-button-holding-closest.html";
export const COVER_REMOVING_THE_BUTTON_HOLDING_PLAIN_PAGE =
    "/cover-removing-the-button-holding-plain.html";
export const COVER_HOLDING_CLOSEST_PAGE = "/cover-holding-closest.html";
export const COVER_HOLDING_PLAIN_PAGE = "/cover-holding-plain.html";

// The browser exposes named elements as properties of the window too.
export const divIdentifiedAsPage = (id: string): string => `/div-identified-as-${id}.html`;

export const DIALOG_ON_PRESS_PAGES = new Map<string, FixtureRoute>([
    ...[FORM_INPUT_NAME_HIDING_NOTHING, ...FORM_INPUT_NAMES_HIDING_A_LISTENER_METHOD].flatMap(
        formHoldingInputRoutes,
    ),
    ...[FORM_INPUT_NAME_HIDING_NOTHING, ...FORM_INPUT_NAMES_HIDING_WHAT_THE_DRIVER_READS].flatMap(
        (inputName) => [formHoldingButtonRoute(inputName), formWithSubmitRoute(inputName)],
    ),
    ...FORM_INPUT_NAMES_HIDING_A_LISTENER_METHOD.map((id): [string, FixtureRoute] => [
        divIdentifiedAsPage(id),
        pageWith("", `<div id="${id}"></div>`),
    ]),
    [
        COVER_REMOVING_THE_BUTTON_HOLDING_CLOSEST_PAGE,
        coveringFormPage("closest", REMOVES_THE_BUTTON),
    ],
    [COVER_REMOVING_THE_BUTTON_HOLDING_PLAIN_PAGE, coveringFormPage("plain", REMOVES_THE_BUTTON)],
    [COVER_HOLDING_CLOSEST_PAGE, coveringFormPage("closest", "")],
    [COVER_HOLDING_PLAIN_PAGE, coveringFormPage("plain", "")],
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
