// Compile-time guarantees. This file is type-checked by type-check.test.ts and never run.
// Each @ts-expect-error line must fail to compile; if one ever compiles, tsc reports an unused
// '@ts-expect-error' directive and the check fails.
import { cdpDriver, type EgressSource } from '@revisum/driver-cdp';
import {
  createRunService,
  lifecycle,
  policyGate,
  type AiPlanner,
  type ClearedRun,
  type EventSink,
  type Logger,
  type Plan,
  type PlanData,
  type RunInputs,
  type RunPorts,
  type TargetId,
  type TrustedProject,
} from '@revisum/engine';

declare const logger: Logger;
declare const inputs: RunInputs;
declare const ports: RunPorts;
declare const cleared: ClearedRun;
declare const planner: AiPlanner;
declare const planned: lifecycle.Planned;
declare const resolved: lifecycle.Resolved;
declare const running: lifecycle.Running;
declare const egress: EgressSource;
declare const trusted: TrustedProject;
declare const events: EventSink;
declare const targetId: TargetId;

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
// A run takes the run the policy gate cleared, which holds the plan the parser made.
export const clearedRunRuns = createRunService(ports).run(cleared, inputs);
// Typed as the plan's data, so every field is well typed and only the parser's brand is missing.
const handBuiltPlan: PlanData = { version: '1.3', meta: cleared.plan.meta, targets: [targetId], steps: cleared.plan.steps };
const gate = policyGate({ project: trusted, events });
gate.clear(cleared.plan, targetId); // allowed
// @ts-expect-error a hand-built object is not a Plan, so it cannot enter the gate; only the plan parser can brand one
gate.clear(handBuiltPlan, targetId);
// @ts-expect-error the same holds for a plan decided for several targets
gate.decide(handBuiltPlan, [targetId]);

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
