// Runtime guard fixture. Every input event of the kinds a driver dispatches to act (pointer and
// mouse presses, clicks, keys, text input and value changes) is counted, whoever sent it, so a
// test can show that a denied action sent none. Each control also shows its own effect.
const shown = (testId) => document.querySelector(`[data-testid="${testId}"]`);
const INPUT_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change'];
let inputEvents = 0;
for (const kind of INPUT_EVENTS) {
  document.addEventListener(kind, () => { inputEvents += 1; shown('input-events').textContent = String(inputEvents); }, true);
}
let saveClicks = 0;
document.getElementById('save').addEventListener('click', () => { saveClicks += 1; shown('save-clicks').textContent = String(saveClicks); });
let noteKeys = 0;
document.getElementById('note').addEventListener('keydown', () => { noteKeys += 1; shown('note-keys').textContent = String(noteKeys); });
document.getElementById('help').addEventListener('mouseover', () => { shown('help-state').textContent = 'open'; });
const size = document.getElementById('size');
size.addEventListener('change', () => { shown('size-chosen').textContent = size.value; });
const attachment = document.getElementById('attachment');
attachment.addEventListener('change', () => { shown('attachment-name').textContent = attachment.files[0] ? attachment.files[0].name : 'none'; });
document.getElementById('ask').addEventListener('click', () => {
  shown('dialog-status').textContent = window.confirm('Keep the draft?') ? 'Kept' : 'Discarded';
});
document.getElementById('ask-to-clear').addEventListener('click', () => {
  shown('dialog-status').textContent = window.confirm('Delete every draft?') ? 'Cleared' : 'Not cleared';
});
