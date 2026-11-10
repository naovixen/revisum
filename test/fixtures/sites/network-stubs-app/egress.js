// The egress page: a fetch a stub may answer, a fetch that goes to the server, and a fetch to an
// origin the egress proxy blocks.
const shown = (id) => document.querySelector(`[data-testid="${id}"]`);
let stubbedAnswers = 0;

document.querySelector('#stubbed').addEventListener('click', async () => {
  const body = await (await fetch('/api/stubbed-data')).json();
  stubbedAnswers += 1;
  shown('stubbed-source').textContent = String(body.source);
  shown('stubbed-count').textContent = String(stubbedAnswers);
});
document.querySelector('#real').addEventListener('click', async () => {
  const body = await (await fetch('/api/real-data')).json();
  shown('real-source').textContent = String(body.source);
});
// A no-cors fetch cannot tell a proxy's refusal from an answer, so the page only says it tried;
// the egress events say what the proxy decided.
document.querySelector('#outside').addEventListener('click', () => {
  const tried = () => { shown('outside-state').textContent = 'Outside tried'; };
  fetch('http://blocked.invalid/data', { mode: 'no-cors' }).then(tried, tried);
});
