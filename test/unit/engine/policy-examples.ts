// Shared setup for the policy-gate tests: a trusted project with a policy, plans parsed against
// it, and the elements a page would resolve each acting step to.
//
// The engine ships irreversible patterns for en, de and fr (delete, pay, send and revoke, and their
// equivalents); a locale such as fr-FR falls back to fr. The trusted project here:
//   - allows two origins, one of them marked production, and keeps production closed;
//   - declares targets in en-GB, de-DE, fr, fr-FR and ja-JP; ja-JP has no pattern set at all;
//   - adds "archive" to the en-GB patterns, declares one destructive URL path, and allows one
//     unnamed control by its test id. It allows no irreversible name.
// The gate is built by policyGate({ project, events }); each denial appends one plan.denied event
// whose code is the rule. A dialog step acts on no element, so the guard receives NO_ELEMENT for it.
// See docs/specs/SPEC-03-policy-gate.md.
import {
  failure, loadTrustedProject, parseProject, planHash, planParser, policyGate, success,
  type EventSink, type Locale, type Plan, type PlanStanding, type PolicyDecision, type PolicyGate, type PolicyRuleId,
  type Project, type ResolvedElement, type Step, type Target, type TrustedProject, type VersionControlPort,
} from '@revisum/engine';
import {
  PLAN_PATH, eventsOfKind, memoryEventSink, withRepository, type MemoryEventSink, type RecordedEvent,
} from './approval-repositories.ts';

export const ORIGIN = 'http://127.0.0.1:4173';
export const PRODUCTION_ORIGIN = 'https://shop.example.com';
// An origin the plan's own project allows but the trusted project does not.
export const UNLISTED_ORIGIN = 'https://staging.example.com';

export const ENGLISH = 'chromium-english';
export const GERMAN = 'chromium-german';
export const FRENCH = 'chromium-french';
// Locale fr-FR, which has no set of its own and falls back to fr.
export const FRENCH_IN_FRANCE = 'chromium-french-france';
export const JAPANESE = 'chromium-japanese';

export const DESTRUCTIVE_PATH = '/account/delete';
// The one control without an accessible name that the project allows, by its test id.
export const ALLOWED_UNNAMED_TEST_ID = 'menu-toggle';
// A word the project adds to the engine's English patterns.
export const PROJECT_PATTERN = 'archive';

export type JsonRecord = Record<string, unknown>;

export const POLICY: JsonRecord = {
  irreversiblePatterns: { 'en-GB': [PROJECT_PATTERN] },
  destructiveUrlPatterns: [DESTRUCTIVE_PATH],
  unnamedControlsAllowedByTestId: [ALLOWED_UNNAMED_TEST_ID],
};

const target = (id: string, locale: string): JsonRecord => ({
  id, adapter: 'cdp', engine: 'chromium', device: 'desktop-1280', locale,
  timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
});

// The project file as a person writes it. `fields` replaces top-level fields, such as `policy`.
export const policyProjectInput = (fields: JsonRecord = {}): JsonRecord => ({
  origins: [ORIGIN, PRODUCTION_ORIGIN],
  productionOrigins: [PRODUCTION_ORIGIN],
  limits: { stepTimeoutMilliseconds: 2000 },
  matrix: [
    target(ENGLISH, 'en-GB'), target(GERMAN, 'de-DE'), target(FRENCH, 'fr'), target(FRENCH_IN_FRANCE, 'fr-FR'), target(JAPANESE, 'ja-JP'),
  ],
  policy: POLICY,
  ...fields,
});

// The project file with its policy changed by `changes`, such as allowed irreversible names.
export const withPolicy = (changes: JsonRecord): JsonRecord => policyProjectInput({ policy: { ...POLICY, ...changes } });

// The project file with the project's own irreversible patterns replaced.
export const withPatterns = (irreversiblePatterns: Readonly<Record<string, readonly string[]>>): JsonRecord =>
  withPolicy({ irreversiblePatterns });

// A protected branch that holds only project.json. No other port method is needed to load it.
function protectedBranchWith(project: JsonRecord): VersionControlPort {
  return {
    protectedBranch: 'main',
    async protectedFile(path) {
      return path === 'project.json'
        ? success({ bytes: new TextEncoder().encode(JSON.stringify(project)), commit: 'commit-protected' })
        : failure('not-found');
    },
    reviews: async () => failure('unavailable'),
    changedFiles: async () => failure('unavailable'),
    pullRequest: async () => failure('unavailable'),
    lastCommitTouching: async () => failure('unavailable'),
    landedBy: async () => failure('unavailable'),
  };
}

// The project as core trusts it: read from the protected branch.
export async function trustedProject(input: JsonRecord = policyProjectInput()): Promise<TrustedProject> {
  const loaded = await loadTrustedProject('project.json', protectedBranchWith(input), { files: [], events: memoryEventSink() });
  if (!loaded.ok) throw new Error(`the policy test project was not trusted: ${JSON.stringify(loaded.error)}`);
  return loaded.value.project;
}

// The project the plan parser reads, from the same file.
export function parserProject(input: JsonRecord = policyProjectInput()): Project {
  const parsed = parseProject(input);
  if (!parsed.ok) throw new Error(`bad policy test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// The last step of every plan built here: a plan must assert something.
export const CLOSING_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'testId', testId: 'account-summary' }, assert: { kind: 'visible' }, criterionId: 'account.summary-shown',
};

// A raw plan: the given steps, then CLOSING_CHECK. Step indexes are the given steps' indexes.
export const planOf = (steps: readonly unknown[], targets: readonly string[] = [ENGLISH]): JsonRecord => ({
  version: '1.1',
  meta: { featureId: 'ACCOUNT-1', specReference: 'specs/account.md#settings', title: 'Account settings' },
  targets,
  steps: [...steps, CLOSING_CHECK],
});

// A plan parsed against `projectInput`, as the plan parser returns it.
export function parsedPlan(raw: JsonRecord, projectInput: JsonRecord = policyProjectInput()): Plan {
  const parsed = planParser(parserProject(projectInput))(raw);
  if (!parsed.ok) throw new Error(`the test plan was rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const role = (roleName: string, name: string): JsonRecord => ({ by: 'role', role: roleName, name });
export const label = (text: string): JsonRecord => ({ by: 'label', label: text });
export const testId = (id: string): JsonRecord => ({ by: 'testId', testId: id });
export const navigate = (url: string): JsonRecord => ({ type: 'navigate', url });
export const click = (locator: JsonRecord): JsonRecord => ({ type: 'click', locator });
export const press = (locator: JsonRecord, key: string): JsonRecord => ({ type: 'press', locator, key });
export const acceptDialog: JsonRecord = { type: 'dialog', action: 'accept' };
export const dismissDialog: JsonRecord = { type: 'dialog', action: 'dismiss' };
export const OPEN_ACCOUNT_PAGE = navigate('/account');

export type TestGate = { readonly gate: PolicyGate; readonly events: MemoryEventSink; readonly project: TrustedProject };

export async function testGate(projectInput: JsonRecord = policyProjectInput()): Promise<TestGate> {
  const project = await trustedProject(projectInput);
  const events = memoryEventSink();
  const sink: EventSink = events;
  return { gate: policyGate({ project, events: sink }), events, project };
}

// The plan's declared targets, as the trusted project's matrix describes them.
export const targetsOf = (project: TrustedProject, plan: Plan): readonly Target[] =>
  project.matrix.filter((candidate) => plan.targets.includes(candidate.id));

// The gate's decision on `plan` for its declared targets. No standing means a proposal.
export const decideOn = (tested: TestGate, plan: Plan, standing?: PlanStanding): PolicyDecision =>
  tested.gate.decide(plan, targetsOf(tested.project, plan), standing);

export function localeOf(project: TrustedProject, targetId: string): Locale {
  const found = project.matrix.find((candidate) => candidate.id === targetId);
  if (found === undefined) throw new Error(`no target ${targetId} in the test project`);
  return found.locale;
}

export function stepAt(plan: Plan, index: number): Step {
  const step = plan.steps[index];
  if (step === undefined) throw new Error(`the plan has no step ${index}`);
  return step;
}

// An element with nothing known about it, changed by `fields`.
export const element = (fields: Partial<ResolvedElement> = {}): ResolvedElement =>
  ({ role: null, name: null, box: null, formSubmitName: null, linkUrl: null, ...fields });

// What the guard receives for a step that acts on no element, such as a dialog step.
export const NO_ELEMENT: ResolvedElement = element();

export const denied = (rule: PolicyRuleId, stepIndex: number | null) => ({ kind: 'deny', rule, stepIndex }) as const;
export const ALLOWED = { kind: 'allow' } as const;

// The decision with an allowed plan reduced to its kind, so decisions compare by value.
export const comparable = (decision: PolicyDecision): JsonRecord =>
  decision.kind === 'allow' ? { kind: 'allow' } : { kind: decision.kind, rule: decision.rule, stepIndex: decision.stepIndex };

// The plan.denied events the gate appended.
export const eventsDenied = (events: MemoryEventSink): readonly RecordedEvent[] => eventsOfKind(events, 'plan.denied');

// The codes of the plan.denied events the gate appended, in order.
export const deniedCodes = (events: MemoryEventSink): readonly string[] => eventsDenied(events).map(({ event }) => String(event.code));

export const PROPOSAL: PlanStanding = { mode: 'proposal' };

// The standing of `plan` once the maintainer of the solo repository has approved it: the plan is
// put on the protected branch, and the maintainer's own merge there is the declared approval.
export async function approvedStanding(plan: Plan): Promise<PlanStanding> {
  let standing: PlanStanding | undefined;
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify({ kind: 'plan', hash: planHash(plan), path: PLAN_PATH }, repository.lockdownProof());
    if (!verified.ok) throw new Error(`the test plan was not approved: ${verified.error}`);
    standing = { mode: 'approved', approval: verified.value.approval };
  }, (fixture) => { fixture.protectedFiles[PLAN_PATH] = plan; });
  if (standing === undefined) throw new Error('no approval');
  return standing;
}
