// Compile-time guarantees. This file is type-checked by type-check.test.ts and never run.
// Each @ts-expect-error line must fail to compile; if one ever compiles, tsc reports an unused
// '@ts-expect-error' directive and the check fails.
import { cdpDriver, type EgressSource } from '@revisum/driver-cdp';
import {
  lifecycle, run,
  type AiPlanner, type Logger, type Plan, type RunInputs, type RunPorts,
} from '@revisum/engine';

declare const logger: Logger;
declare const inputs: RunInputs;
declare const ports: RunPorts;
declare const planner: AiPlanner;
declare const planned: lifecycle.Planned;
declare const resolved: lifecycle.Resolved;
declare const running: lifecycle.Running;
declare const egress: EgressSource;

// ---- Logging manifest ---------------------------------------------------------------------------
logger.log({ kind: 'step.end', stepIndex: 1, outcome: 'passed' }); // allowed
// @ts-expect-error 'email' is not in LOGGING_MANIFEST
logger.log({ kind: 'step.end', email: 'ada@example.test' });
const smuggled = { kind: 'step.end' as const, value: 'typed secret' };
// @ts-expect-error a non-manifest field is rejected even when passed through a variable
logger.log(smuggled);
// @ts-expect-error manifest fields keep their declared types (stepIndex is a number)
logger.log({ kind: 'step.end', stepIndex: 'one' });
// @ts-expect-error event kinds are a closed set
logger.log({ kind: 'debug' });

// ---- AI containment -----------------------------------------------------------------------------
const proposal = await planner.propose({ specReference: 'specs/x.md', text: 'x' });
// @ts-expect-error AI output is unknown and cannot be used as a Plan
const asPlan: Plan = proposal;
// @ts-expect-error a hand-built object is not a Plan; only the plan parser can brand one
run({ ...inputs, plan: { version: 1, meta: inputs.plan.meta, targets: [], steps: [] } }, ports);

// ---- Lifecycle state machine --------------------------------------------------------------------
lifecycle.start(resolved); // allowed: Resolved -> Running
// @ts-expect-error Planned cannot start without being resolved
lifecycle.start(planned);
// @ts-expect-error Resolved cannot finish without running
lifecycle.finish(resolved, 'Passed');
// @ts-expect-error Running cannot become TargetUnavailable (only Planned can)
lifecycle.finish(running, 'TargetUnavailable');
// @ts-expect-error TargetUnavailable is reachable only from Planned
lifecycle.targetUnavailable(running, { reason: 'launch-failed', detail: '' });
lifecycle.transition('Planned', 'Resolved'); // allowed
// @ts-expect-error terminal states have no successors
lifecycle.transition('Passed', 'Running');
// @ts-expect-error no skipping from Planned straight to Running
lifecycle.transition('Planned', 'Running');

// ---- Session egress -----------------------------------------------------------------------------
cdpDriver({ executablePath: 'chrome', egress }); // allowed
// @ts-expect-error a driver with no egress source could open a session that no proxy watches
cdpDriver({ executablePath: 'chrome' });
// @ts-expect-error a session's proxy comes from its egress source, never from the driver's options
cdpDriver({ executablePath: 'chrome', egress, proxy: { server: 'http://127.0.0.1:1', includeLoopback: true } });

export { asPlan };
