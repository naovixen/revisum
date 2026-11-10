// Echoes the token field's value (or, when it is empty, the plain note field's) inside longer
// encoded texts: a Basic authorisation header for user names of 3, 4 and 5 bytes, so the value
// starts at each byte offset of a base64 group, with more text after it; a form body as
// URLSearchParams writes it; and a query parameter percent-encoded with lower-case hex.
const echo = (form, text) => { document.getElementById(`echo-${form}`).textContent = `${form}: ${text}`; };
const base64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

document.getElementById('show').addEventListener('click', () => {
  const value = document.getElementById('token').value || document.getElementById('note').value;
  echo('basic-offset-0', `Basic ${base64(`al:${value}@v=1`)}`);
  echo('basic-offset-1', `Basic ${base64(`bob:${value}@v=1`)}`);
  echo('basic-offset-2', `Basic ${base64(`carl:${value}@v=1`)}`);
  echo('form', new URLSearchParams({ password: value }).toString());
  echo('lower-hex', `path=${encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase())}`);
});
