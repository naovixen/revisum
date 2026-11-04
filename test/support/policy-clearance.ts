// Clears a test plan through the policy gate, as every run must, before run(). A run takes only an
// Authorised plan, and only the gate makes one. The project is trusted the way core trusts it:
// read from a protected branch that holds just project.json.
import { loadTrustedProject, policyGate, type Authorised, type Plan, type PlanStanding, type TrustedProject } from '@revisum/engine';
import { fakeEventSink } from './fakes/FakeEventSink.ts';
import { fakeProtectedBranchHolding } from './fakes/FakeVersionControlPort.ts';

// The trusted project for a project file, written the way a person writes project.json.
export async function trustedProjectFrom(projectFile: unknown): Promise<TrustedProject> {
  const loaded = await loadTrustedProject('project.json', fakeProtectedBranchHolding(projectFile), { files: [], events: fakeEventSink() });
  if (!loaded.ok) throw new Error(`the test project was not trusted: ${JSON.stringify(loaded.error)}`);
  return loaded.value.project;
}

// The plan as the gate authorises it for its declared targets. A missing standing is a proposal.
// A test plan the gate denies is a broken test, so it throws.
export function authorise(plan: Plan, project: TrustedProject, standing?: PlanStanding): Authorised {
  const targets = project.matrix.filter((target) => plan.targets.includes(target.id));
  const decision = policyGate({ project, events: fakeEventSink() }).decide(plan, targets, standing);
  if (decision.kind === 'deny') throw new Error(`the policy gate denied the test plan: ${decision.rule} at step ${String(decision.stepIndex)}`);
  return decision.plan;
}
