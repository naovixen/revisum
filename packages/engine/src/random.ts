// Seeded randomness (the mulberry32 generator). The determinism script in contracts runs the same
// generator in the page, so the engine and the app under test see the same sequence for a seed.
import type { Random } from '@revisum/contracts';

export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return {
    seed,
    next() {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    },
  };
}
