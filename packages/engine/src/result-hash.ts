// The result hash, the same way for plan runs and evidence runs: everything in the result except
// its timings and the manifest body, which the manifest's own hash covers.
import { canonicalJson, sha256 } from './hashing.ts';
import type { RunResult } from './run.ts';

export function withResultHash(result: Omit<RunResult, 'resultHash'>): RunResult {
  const { timings: _excluded, manifest: _coveredByHash, ...hashed } = result;
  return { ...result, resultHash: sha256(canonicalJson(hashed)) };
}
