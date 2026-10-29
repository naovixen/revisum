// Auto-wait fixture. The page's data-case attribute says how its one "Continue" button is not
// actionable for its first 400 ms: added late, hidden, moving, disabled or covered by another
// element. The "never" cases stay that way. The result line counts clicks on the button, clicks
// that reached it before it was ready, clicks that landed on anything else, and clicks on the cover.
const DELAY_MILLISECONDS = 400;
const scenario = document.body.dataset.case;
const stage = document.getElementById('stage');
const result = document.querySelector('[data-testid="result"]');
const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Continue';
let cover = null;
let ready = false;
let clicks = 0;
let early = 0;
let stray = 0;
let overlay = 0;
const show = () => { result.textContent = `clicks=${clicks} early=${early} stray=${stray} overlay=${overlay}`; };
button.addEventListener('click', () => { clicks += 1; if (!ready) early += 1; show(); });
document.addEventListener('click', (event) => {
  if (event.target !== button && event.target !== cover) { stray += 1; show(); }
}, true);
const becomeReady = (change) => setTimeout(() => { change(); ready = true; }, DELAY_MILLISECONDS);

if (scenario === 'late') {
  becomeReady(() => stage.appendChild(button));
} else {
  stage.appendChild(button);
}
if (scenario === 'hidden') {
  button.hidden = true;
  becomeReady(() => { button.hidden = false; });
}
if (scenario === 'moving') {
  // A new position on every animation frame, as an animation moves an element, until it stops.
  let step = 0;
  let moving = true;
  const move = () => {
    if (!moving) return;
    step += 1;
    button.style.left = `${(step % 8) * 60}px`;
    requestAnimationFrame(move);
  };
  requestAnimationFrame(move);
  becomeReady(() => { moving = false; button.style.left = '120px'; });
}
if (scenario === 'disabled' || scenario === 'never') {
  button.disabled = true;
  if (scenario === 'disabled') becomeReady(() => { button.disabled = false; });
}
if (scenario === 'covered' || scenario === 'never-covered') {
  cover = document.createElement('div');
  cover.id = 'cover';
  cover.addEventListener('click', () => { overlay += 1; show(); });
  document.body.appendChild(cover);
  if (scenario === 'covered') becomeReady(() => cover.remove());
}
