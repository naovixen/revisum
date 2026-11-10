// An animation-frame callback that asks for the next frame every time it runs: a loop with no end.
let framesRun = 0;
const nextFrame = () => {
  framesRun += 1;
  show('frames-run', String(framesRun));
  requestAnimationFrame(nextFrame);
};
requestAnimationFrame(nextFrame);
