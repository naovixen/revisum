// Counts the other open pages of this origin in the same browser context. "Count other tabs"
// asks every other page on a broadcast channel, waits 300 ms for answers, and shows how many
// answered; a closed tab cannot answer. Every page with this script answers others' questions.
const tabsChannel = new BroadcastChannel('page-states-tabs');
const otherTabs = document.querySelector('[data-testid="other-tabs"]');
let answers = 0;
tabsChannel.addEventListener('message', (event) => {
  if (event.data === 'ping') tabsChannel.postMessage('pong');
  else if (event.data === 'pong') answers += 1;
});
document.getElementById('count-tabs').addEventListener('click', () => {
  answers = 0;
  otherTabs.textContent = 'counting';
  tabsChannel.postMessage('ping');
  setTimeout(() => { otherTabs.textContent = String(answers); }, 300);
});
