// The requests page: each button sends fetch requests and shows what came back, so a test can tell
// a stubbed answer from the server's and count the requests the page sent.
const shown = (id) => document.querySelector(`[data-testid="${id}"]`);
const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

fetch('/api/schedule').then((response) => {
  shown('schedule-state').textContent = response.ok ? 'Schedule loaded' : `Schedule failed with ${response.status}`;
});

document.querySelector('#ask').addEventListener('click', async () => {
  const response = await fetch('/api/sequence');
  const answer = await response.json();
  const list = shown('answers');
  list.textContent = list.textContent === '' ? String(answer.answer) : `${list.textContent} ${answer.answer}`;
});

document.querySelector('#batches').addEventListener('click', async () => {
  // Neither of these matches a GET of exactly /api/items.
  void fetch('/api/items-archive');
  void fetch('/api/items', { method: 'POST', body: '{}' });
  const first = fetch('/api/items');
  await pause(300);
  const second = fetch('/api/items?slow=1');
  const answers = await Promise.all([first, second]);
  await Promise.all(answers.map((response) => response.text()));
  shown('batches-state').textContent = 'Both batches loaded';
});

const showItems = async (url) => {
  const response = await fetch(url);
  const body = await response.json();
  shown('first-item').textContent = body.items[0].name;
  shown('item-count').textContent = String(body.items.length);
};
document.querySelector('#items').addEventListener('click', () => showItems('/api/items'));
document.querySelector('#next-page').addEventListener('click', () => showItems('/api/items?page=2'));

document.querySelector('#big-items').addEventListener('click', async () => {
  await (await fetch('/api/big-items')).text();
  shown('big-state').textContent = 'Big items loaded';
});
document.querySelector('#plain-items').addEventListener('click', async () => {
  await (await fetch('/api/plain-items')).text();
  shown('plain-state').textContent = 'Plain items loaded';
});
document.querySelector('#missing-items').addEventListener('click', async () => {
  const response = await fetch('/api/missing-items');
  await response.text();
  shown('missing-state').textContent = `Missing items answered ${response.status}`;
});
