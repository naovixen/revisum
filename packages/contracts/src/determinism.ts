// The page-side determinism controls every driver injects before any page script runs: a frozen
// clock, seeded randomness and no animation. It is a trusted constant; plans cannot add to it.
// It lives here because every driver needs it and a driver may import only this package.

// Removes animation, transitions and caret blink.
export const NO_MOTION_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

// The source of a script that freezes Date at fixedTimeMilliseconds, seeds Math.random with the
// same generator as the engine's seededRandom (mulberry32), and disables animation.
export function determinismScript(seed: number, fixedTimeMilliseconds: number): string {
  if (!Number.isInteger(seed) || !Number.isInteger(fixedTimeMilliseconds)) {
    throw new TypeError('seed and fixedTimeMilliseconds must be integers');
  }
  return `
(() => {
  const FIXED = ${fixedTimeMilliseconds};
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }
  globalThis.Date = FrozenDate;
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
})();`;
}
