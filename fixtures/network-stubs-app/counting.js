// Counts every input event of the kinds a driver dispatches to act (pointer and mouse presses,
// clicks, keys, text input and value changes), whoever sent it, into the element whose test id is
// "input-events", so a test can show that a refused or failed step sent none.
const INPUT_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change'];
let inputEvents = 0;
const inputEventCounter = document.querySelector('[data-testid="input-events"]');
for (const kind of INPUT_EVENTS) {
  document.addEventListener(kind, () => { inputEvents += 1; inputEventCounter.textContent = String(inputEvents); }, true);
}
