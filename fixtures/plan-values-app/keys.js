// Key chord fixture. Each keydown and keyup the editor receives is logged, separated by spaces:
//   a modifier key as "down:Control" or "up:Control", by its key name;
//   any other key as "down:KeyK[Alt+Control+Shift]", by its physical code, with the modifiers
//   held at that moment in brackets, in the order Alt, Control, Meta, Shift ("[]" when none).
const MODIFIER_KEYS = ['Alt', 'Control', 'Meta', 'Shift'];
const editor = document.getElementById('editor');
const keyLog = document.querySelector('[data-testid="key-log"]');
const entries = [];
const held = (event) => [
  event.altKey ? 'Alt' : '', event.ctrlKey ? 'Control' : '', event.metaKey ? 'Meta' : '', event.shiftKey ? 'Shift' : '',
].filter((name) => name !== '').join('+');
for (const type of ['keydown', 'keyup']) {
  editor.addEventListener(type, (event) => {
    const direction = type === 'keydown' ? 'down' : 'up';
    entries.push(MODIFIER_KEYS.includes(event.key) ? `${direction}:${event.key}` : `${direction}:${event.code}[${held(event)}]`);
    keyLog.textContent = entries.join(' ');
  });
}
