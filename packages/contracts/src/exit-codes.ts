// The process exit codes a run ends with. One run gives one code: when several apply, the first in
// EXIT_PRECEDENCE wins. See docs/specs/SPEC-11-result-model-and-exporters.md.

// 0 passed, 1 failed, 2 plan rejected, 3 a required target unavailable, 4 internal error, 5 needs review.
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;
export const EXIT_PRECEDENCE: readonly ExitCode[] = [4, 2, 3, 1, 5, 0];

// What an unavailable target means for the run: a required one fails it with exit code 3; an
// optional one is skipped with a warning, so neither passes silently.
export type UnavailableTargetOutcome =
  | { readonly exitCode: 3 }
  | { readonly exitCode: 0; readonly skipped: true; readonly warning: string };
