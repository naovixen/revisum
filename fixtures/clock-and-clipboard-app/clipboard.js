// Copy buttons for the clipboard checks, and a button whose own script tries to read the
// clipboard. A read shows only how many characters it got, never the text.
//   - "Copy invite code": one line.
//   - "Copy address": three lines joined by CRLF line endings.
//   - "Copy late code": copies once /api/late-code has answered, about 300 ms after the press.
//   - "Copy long text": 25,000 characters, more than the project's maximumClipboardCharacters.
//   - "Copy invite link": a link built from the "Email address" field.
const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    show('copy-state', `Copied ${text.length} characters`);
  } catch (error) {
    show('copy-state', `Copy refused: ${error.name}`);
  }
};
document.querySelector('#copy-one-line').addEventListener('click', () => copy('Invite code: HX-4471'));
document.querySelector('#copy-address').addEventListener('click', () => copy('Ada Lovelace\r\n12 St James Square\r\nLondon'));
document.querySelector('#copy-later').addEventListener('click', async () => {
  const response = await fetch('/api/late-code');
  await copy(`Late code: ${await response.text()}`);
});
document.querySelector('#copy-long').addEventListener('click', () => copy('Long text '.repeat(2500)));
document.querySelector('#copy-invite').addEventListener('click', () => {
  copy(`${location.origin}/join?email=${document.querySelector('#invite-email').value}`);
});
let readAttempts = 0;
document.querySelector('#read-clipboard').addEventListener('click', async () => {
  readAttempts += 1;
  const attempt = readAttempts;
  try {
    const text = await navigator.clipboard.readText();
    show('page-read', `Read ${text.length} characters, attempt ${attempt}`);
  } catch {
    show('page-read', `Refused, attempt ${attempt}`);
  }
});
