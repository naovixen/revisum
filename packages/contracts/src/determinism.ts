// The page-side determinism controls every driver injects before any page script runs: a frozen
// clock, seeded randomness and no animation. It is a trusted constant; plans cannot add to it.
// It lives here because every driver needs it and a driver may import only this package.
//
// The clock part is the run's virtual clock. Date.now() is the frozen start plus however far the
// run has advanced its clock, and performance.now() is how far it has advanced since the document
// loaded; with no advance both stay frozen. Its timer tracking is off until a driver that advances
// the clock turns it on with virtualClockScript: from then on the page's timeouts, intervals and
// animation frames wait for advances instead of real time, and the advance controller fires them.
// The controller sits in the page's main world, beside the timers, so the page could call it; it
// gives no new power, since a page could already replace its own Date and timers.
// See docs/specs/SPEC-08-manifest-and-replay.md and docs/specs/SPEC-34-clock-advance-and-clipboard.md.

// Removes animation, transitions and caret blink.
export const NO_MOTION_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

// The name, given to Symbol.for, of the window property that holds the advance controller.
export const CLOCK_CONTROLLER_KEY = 'determinism-kit.clock-controller';

// Animation-frame callbacks run once per this many milliseconds of virtual time while any wait.
const VIRTUAL_FRAME_MILLISECONDS = 16;

// The source of a script that freezes Date at fixedTimeMilliseconds, seeds Math.random with the
// same generator as the engine's seededRandom (mulberry32), disables animation, and installs the
// virtual clock's timer tracking and advance controller, turned off.
//
// The controller's advanceTo(target, mode, maximumCallbacks) moves the document's virtual time to
// `target` milliseconds after the start and resolves to { fired, runaway }:
//   - runTimers fires every timer due by the target, end included, at its own virtual time, in
//     due-time order with ties in scheduling order; intervals repeat, and timers the callbacks
//     schedule fire too if they come due in time. Waiting animation-frame callbacks run once per
//     16 ms of virtual time. Promise jobs run between callbacks.
//   - skipAhead jumps to the target, then fires once each timer that is due by then, intervals
//     included, and each waiting animation-frame callback.
// Before a callback past maximumCallbacks would fire, it stops with runaway true.
export function determinismScript(seed: number, fixedTimeMilliseconds: number): string {
  if (!Number.isInteger(seed) || !Number.isInteger(fixedTimeMilliseconds)) {
    throw new TypeError('seed and fixedTimeMilliseconds must be integers');
  }
  return `
(() => {
  const FIXED = ${fixedTimeMilliseconds};
  const FRAME = ${VIRTUAL_FRAME_MILLISECONDS};
  const RealDate = Date;
  // Milliseconds of virtual time the run has advanced, and how far it had when this document began.
  const clock = { elapsed: 0, documentStart: 0 };
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED + clock.elapsed); else super(...args); }
    static now() { return FIXED + clock.elapsed; }
  }
  globalThis.Date = FrozenDate;
  const performanceNow = () => clock.elapsed - clock.documentStart;
  Object.defineProperty(performance, 'now', { value: performanceNow, configurable: true, writable: true });
  let state = ${seed >>> 0};
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const css = ${JSON.stringify(NO_MOTION_CSS)};
  const add = () => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) add(); else document.addEventListener('readystatechange', add, { once: true });

  // ---- The virtual clock's timers and its advance controller ----
  const RealMessageChannel = MessageChannel;
  const reportError = typeof globalThis.reportError === 'function' ? globalThis.reportError.bind(globalThis) : () => undefined;
  const indirectEval = eval;
  const timers = new Map();
  const frames = new Map();
  let nextId = 1;
  let nextOrder = 1;
  let virtual = false;
  const callable = (handler) => (typeof handler === 'function' ? handler : () => indirectEval(String(handler)));
  const schedule = (handler, delay, args, repeats) => {
    const wait = Math.max(0, Math.floor(Number(delay) || 0));
    const id = nextId++;
    // An interval of 0 would repeat for ever at one instant; browsers wait at least 1 ms.
    timers.set(id, { due: clock.elapsed + wait, order: nextOrder++, callback: callable(handler), args, interval: repeats ? Math.max(wait, 1) : null });
    return id;
  };
  // Lets every promise job the last callback queued run before the next callback fires.
  const settle = () => new Promise((resolve) => {
    const channel = new RealMessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(null);
  });
  const earliestDue = (target) => {
    let found = null;
    for (const [id, timer] of timers) {
      if (timer.due > target) continue;
      if (found === null || timer.due < found.timer.due || (timer.due === found.timer.due && timer.order < found.timer.order)) found = { id, timer };
    }
    return found;
  };
  const controller = {
    useVirtualTimers(elapsed) {
      if (virtual) return;
      virtual = true;
      clock.elapsed = elapsed;
      clock.documentStart = elapsed;
      globalThis.setTimeout = function setTimeout(handler, delay, ...args) { return schedule(handler, delay, args, false); };
      globalThis.setInterval = function setInterval(handler, delay, ...args) { return schedule(handler, delay, args, true); };
      globalThis.clearTimeout = function clearTimeout(id) { timers.delete(Number(id)); };
      globalThis.clearInterval = function clearInterval(id) { timers.delete(Number(id)); };
      globalThis.requestAnimationFrame = function requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id; };
      globalThis.cancelAnimationFrame = function cancelAnimationFrame(id) { frames.delete(Number(id)); };
    },
    async advanceTo(target, mode, maximumCallbacks) {
      let fired = 0;
      // False when the callback would pass the limit, so it is not called.
      const fire = async (callback, args) => {
        if (fired >= maximumCallbacks) return false;
        fired += 1;
        try { callback.apply(globalThis, args); } catch (error) { reportError(error); }
        await settle();
        return true;
      };
      const fireTimer = (id, timer) => {
        if (timer.interval === null) timers.delete(id);
        else { timer.due = clock.elapsed + timer.interval; timer.order = nextOrder++; }
        return fire(timer.callback, timer.args);
      };
      const fireFrames = async () => {
        const waiting = [...frames.values()];
        frames.clear();
        for (const callback of waiting) if (!(await fire(callback, [performanceNow()]))) return false;
        return true;
      };
      if (target < clock.elapsed) return { fired, runaway: false };
      if (mode === 'skipAhead') {
        clock.elapsed = target;
        const due = [];
        for (const [id, timer] of timers) if (timer.due <= target) due.push({ id, timer });
        due.sort((left, right) => left.timer.due - right.timer.due || left.timer.order - right.timer.order);
        for (const { id, timer } of due) {
          // A timer an earlier callback cleared does not fire.
          if (timers.get(id) !== timer) continue;
          if (!(await fireTimer(id, timer))) return { fired, runaway: true };
        }
        if (!(await fireFrames())) return { fired, runaway: true };
        return { fired, runaway: false };
      }
      for (;;) {
        const next = earliestDue(target);
        const frameAt = frames.size > 0 ? (Math.floor(clock.elapsed / FRAME) + 1) * FRAME : Infinity;
        if (frameAt <= target && (next === null || frameAt < next.timer.due)) {
          clock.elapsed = frameAt;
          if (!(await fireFrames())) return { fired, runaway: true };
          continue;
        }
        if (next === null) break;
        clock.elapsed = next.timer.due;
        if (!(await fireTimer(next.id, next.timer))) return { fired, runaway: true };
      }
      clock.elapsed = target;
      return { fired, runaway: false };
    },
  };
  Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(CLOCK_CONTROLLER_KEY)}), { value: controller });
})();`;
}

// The source of a script that turns on the virtual clock's timer tracking in a new document,
// starting at elapsedMilliseconds after the frozen start. A driver that advances the clock adds it
// after determinismScript, and adds it again at the new time after every advance, so a document
// loaded later starts where the run's clock is and page time never goes backwards.
export function virtualClockScript(elapsedMilliseconds: number): string {
  if (!Number.isInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) {
    throw new TypeError('elapsedMilliseconds must be a whole number, at least 0');
  }
  return `globalThis[Symbol.for(${JSON.stringify(CLOCK_CONTROLLER_KEY)})]?.useVirtualTimers(${elapsedMilliseconds});`;
}
