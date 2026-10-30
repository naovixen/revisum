// A zero-delay timeout that schedules itself again every time it runs: a loop with no end.
let loopRuns = 0;
const runAgain = () => {
  loopRuns += 1;
  show('loop-runs', String(loopRuns));
  setTimeout(runAgain, 0);
};
setTimeout(runAgain, 0);
