// Echoes the token field's value (or, when it is empty, the plain note field's) in each form a leak can take, so a test can prove the engine's
// redaction removes every one of them from what a run keeps. The prefix keeps 20 characters.
const echo = (form, text) => { document.getElementById(`echo-${form}`).textContent = `${form}: ${text}`; };
const base64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

document.getElementById('show').addEventListener('click', () => {
  const value = document.getElementById('token').value || document.getElementById('note').value;
  echo('raw', value);
  echo('uri', encodeURIComponent(value));
  echo('base64', base64(value));
  echo('base64url', base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  echo('prefix', `${value.slice(0, 20)}...`);
  echo('upper', value.toUpperCase());
  echo('lower', value.toLowerCase());
});
