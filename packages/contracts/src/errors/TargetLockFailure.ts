// The lockfile's types: each target pinned to an exact browser build by version and executable
// sha256, so a run on another build is refused rather than reported as the same test.
import type { BuildFailureCode } from '../ports/BrowserDriver.ts';
import type { TargetId } from '../ports/Target.ts';

export type LockEntry = { readonly targetId: TargetId; readonly version: string; readonly executableSha256: string };

// Why locking failed for a named target: the adapter's build failure, a refusal of the target, or
// build-mismatch when a re-lock finds the pinned version with other bytes.
export type TargetLockFailure = { readonly targetId: TargetId; readonly code: BuildFailureCode; readonly detail: string };
// Why the lockfile itself could not be used: it does not parse, or it could not be written.
export const LockfileFailureCode = {
  LockfileInvalid: 'lockfile-invalid',
  LockfileUnwritable: 'lockfile-unwritable',
} as const;
export type LockfileFailureCode = (typeof LockfileFailureCode)[keyof typeof LockfileFailureCode];
export type LockfileFailure = { readonly targetId: null; readonly code: LockfileFailureCode; readonly detail: string };
export type LockFailure = TargetLockFailure | LockfileFailure;
