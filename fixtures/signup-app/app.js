const $ = (id) => document.getElementById(id);
const set = (testId, value) => { document.querySelector(`[data-testid="${testId}"]`).textContent = String(value); };
set('env-lang', navigator.language);
set('env-tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
set('env-now', new Date().toISOString());
set('env-hour', new Date().getHours());
set('env-random', Math.random().toFixed(6));
set('env-motion', matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference');
set('env-scheme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

$('signup').addEventListener('submit', (event) => {
  event.preventDefault();
  const status = $('status');
  status.textContent = '';
  if (!$('terms').checked) { status.textContent = 'Please accept the terms.'; return; }
  const who = document.createElement('span');
  who.setAttribute('data-pii', '');
  who.textContent = $('name').value;
  const reference = Math.floor(Math.random() * 1e6);
  status.append('Welcome, ', who, `! Reference ${reference}.`);
  $('echo').textContent = `Signed up as ${$('email').value}`;
});
