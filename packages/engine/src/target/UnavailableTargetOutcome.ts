// What an unavailable target means for the whole run. A required target fails it with exit code 3;
// an optional one is marked skipped with a warning that names it. Neither passes silently.
// The JUnit exporter and the CLI read this.
import type { Target, UnavailableTargetOutcome } from '@revisum/contracts';
import { isRequiredTarget } from './TargetFidelity.ts';

export function unavailableTargetOutcome(target: Target): UnavailableTargetOutcome {
  if (isRequiredTarget(target)) return { exitCode: 3 };
  return { exitCode: 0, skipped: true, warning: `the optional target ${target.id} was unavailable, so it was skipped and not tested` };
}
