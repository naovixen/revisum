// The resources page. "Load notes" fetches data whose text holds script markup and shows it only
// as text. "Load every resource" asks /api/assets/ for a script, a style sheet, a frame, a worker
// and an image, which a stub must leave to the network, and for data by fetch and by XHR, which a
// stub may answer. Every line says who answered: the server's files say "from server", a stub's
// JSON says "from stub".
const shown = (id) => document.querySelector(`[data-testid="${id}"]`);

// Script markup that runs anywhere on this page, or in a same-origin frame of it, calls this.
window.countScriptRun = () => {
  const counter = shown('script-runs');
  counter.textContent = String(Number(counter.textContent) + 1);
};

document.querySelector('#notes').addEventListener('click', async () => {
  const response = await fetch('/api/notes');
  shown('notes-type').textContent = response.headers.get('content-type') ?? 'none';
  shown('notes-sniffing').textContent = response.headers.get('x-content-type-options') ?? 'none';
  const text = await response.text();
  let note = '';
  try { note = String(JSON.parse(text).note); } catch { note = ''; }
  shown('notes-kind').textContent = note.includes('<script>') ? 'Markup kept as text' : 'No markup received';
});

document.querySelector('#notes-page').addEventListener('click', () => {
  const frame = document.createElement('iframe');
  frame.src = '/notes-as-page.html';
  frame.title = 'Notes as a page';
  document.querySelector('#notes-frame-holder').append(frame);
});

const fromJson = (text) => {
  try { return `${JSON.parse(text).source} answered`; } catch { return 'unreadable answer'; }
};

document.querySelector('#resources').addEventListener('click', () => {
  const holder = document.querySelector('#resource-holder');

  // The server's script sets this line itself; a stubbed answer, if any, would not run.
  const script = document.createElement('script');
  script.src = '/api/assets/widget.js';
  script.onerror = () => { shown('script-state').textContent = 'Script failed'; };
  holder.append(script);

  // The server's style sheet makes the box 123 px wide.
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/api/assets/theme.css';
  style.onload = () => {
    const width = document.querySelector('#styled').getBoundingClientRect().width;
    shown('style-state').textContent = width === 123 ? 'Style from server' : `Style loaded at ${width} px`;
  };
  style.onerror = () => { shown('style-state').textContent = 'Style failed'; };
  document.head.append(style);

  // The server's frame page tells its parent it loaded.
  window.addEventListener('message', (event) => {
    if (event.data === 'frame from server') shown('frame-state').textContent = 'Frame from server';
    if (event.data === 'worker from server') shown('worker-state').textContent = 'Worker from server';
  });
  const frame = document.createElement('iframe');
  frame.src = '/api/assets/frame.html';
  frame.title = 'Asset frame';
  holder.append(frame);

  // The server's worker posts one message back.
  try {
    const worker = new Worker('/api/assets/worker.js');
    worker.onmessage = (event) => { if (event.data === 'worker from server') shown('worker-state').textContent = 'Worker from server'; };
    worker.onerror = () => { shown('worker-state').textContent = 'Worker failed'; };
  } catch {
    shown('worker-state').textContent = 'Worker refused';
  }

  // The server's image is an SVG; JSON in its place would not decode.
  const image = new Image();
  image.onload = () => { shown('image-state').textContent = 'Image from server'; };
  image.onerror = () => { shown('image-state').textContent = 'Image failed'; };
  image.src = '/api/assets/pixel.svg';
  image.alt = '';
  holder.append(image);

  fetch('/api/assets/data.json').then((response) => response.text()).then((text) => { shown('fetch-state').textContent = `Fetch: ${fromJson(text)}`; });

  const request = new XMLHttpRequest();
  request.open('GET', '/api/assets/data.json?by=xhr');
  request.onload = () => { shown('xhr-state').textContent = `XHR: ${fromJson(request.responseText)}`; };
  request.onerror = () => { shown('xhr-state').textContent = 'XHR failed'; };
  request.send();
});
