// Clears a test plan through the policy gate, as every run must, before run(). A run takes only an
// Authorised plan, and only the gate makes one. The project is trusted the way core trusts it:
// read from a protected branch that holds just project.json.
// See docs/specs/SPEC-03-policy-gate.md.
import {
  failure, loadTrustedProject, policyGate, success,
  type Authorised, type EventSink, type Plan, type PlanStanding, type TrustedProject, type VersionControlPort,
} from '@revisum/engine';

// An audit sink that keeps nothing: these helpers only need the decision.
const discardingSink: EventSink = { append: () => success({ sequence: 0 }) };

function protectedBranchWith(projectFile: unknown): VersionControlPort {
  return {
    protectedBranch: 'main',
    async protectedFile(path) {
      return path === 'project.json'
        ? success({ bytes: new TextEncoder().encode(JSON.stringify(projectFile)), commit: 'commit-protected' })
        : failure('not-found');
    },
    reviews: async () => failure('unavailable'),
    changedFiles: async () => failure('unavailable'),
    pullRequest: async () => failure('unavailable'),
    lastCommitTouching: async () => failure('unavailable'),
    landedBy: async () => failure('unavailable'),
  };
}

// The trusted project for a project file, written the way a person writes project.json.
export async function trustedProjectFrom(projectFile: unknown): Promise<TrustedProject> {
  const loaded = await loadTrustedProject('project.json', protectedBranchWith(projectFile), { files: [], events: discardingSink });
  if (!loaded.ok) throw new Error(`the test project was not trusted: ${JSON.stringify(loaded.error)}`);
  return loaded.value.project;
}

// The plan as the gate authorises it for its declared targets. A missing standing is a proposal.
// A test plan the gate denies is a broken test, so it throws.
export function authorise(plan: Plan, project: TrustedProject, standing?: PlanStanding): Authorised {
  const targets = project.matrix.filter((target) => plan.targets.includes(target.id));
  const decision = policyGate({ project, events: discardingSink }).decide(plan, targets, standing);
  if (decision.kind === 'deny') throw new Error(`the policy gate denied the test plan: ${decision.rule} at step ${String(decision.stepIndex)}`);
  return decision.plan;
}
