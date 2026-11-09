// Chat box fixture: shows the box's value as JSON and its line count as it changes, counts Enter
// key presses, and "sends" the message on Enter, as a chat box does.
const shown = (testId) => document.querySelector(`[data-testid="${testId}"]`);
const message = document.getElementById('message');
let enterPresses = 0;
message.addEventListener('input', () => {
  shown('message-json').textContent = JSON.stringify(message.value);
  shown('message-lines').textContent = String(message.value === '' ? 0 : message.value.split('\n').length);
});
message.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  enterPresses += 1;
  shown('enter-presses').textContent = String(enterPresses);
  event.preventDefault();
  shown('sent').textContent = `sent: ${message.value}`;
});
