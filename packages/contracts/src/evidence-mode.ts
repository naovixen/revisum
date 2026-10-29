// Evidence mode: Revisum runs a team's own Playwright Test suite, which only the trusted project
// file can turn on, and wraps it with its evidence. Revisum cannot vouch for what the suite's code
// checks, so every evidence result carries the `host` guarantee level and a statement of which
// guarantees hold and which are lost.
// See docs/specs/SPEC-35-evidence-mode.md.
import type { Brand } from './brand.ts';
import type { CriterionId, SafeText, SecretName } from './plan.ts';
import type { ArtifactReference, GuaranteeLevel } from './run-ports.ts';
import type { UnsafeFeature } from './unsafe-plan-features.ts';

// A declared suite's name, as `run --suite <name>` gives it: a lowercase letter, then up to 39
// lowercase letters, digits or hyphens.
export type SuiteName = Brand<string, 'SuiteName'>;
// A container image pinned by content: "sha256:" and 64 lowercase hex digits. Never a tag, which
// can be moved to another image.
export type ImageDigest = Brand<string, 'ImageDigest'>;

// A variable the suite's process receives: literal text, or a secret the project declares, resolved
// through the secret store when the suite runs.
export type EnvironmentValue = { readonly literal: SafeText } | { readonly secretName: SecretName };

export type EvidenceSuiteDeclaration = {
  readonly name: SuiteName;
  // The only framework in phase 1.
  readonly framework: 'playwright-test';
  // Repository-relative globs of the suite's files, its helpers and config included. They are
  // trusted files: a change that edits one runs the protected-branch version.
  readonly paths: readonly string[];
  // Repository-relative, inside the checkout.
  readonly workingDirectory: string;
  readonly image: ImageDigest;
  // An argument vector run without a shell before the suite, under the same egress policy.
  readonly setupCommand?: readonly SafeText[];
  // An argument vector run without a shell. It always invokes Playwright Test.
  readonly command: readonly SafeText[];
  // The Playwright project names to run; at least one.
  readonly projects: readonly SafeText[];
  // Never a name Revisum sets itself, such as PATH or any *_PROXY name.
  readonly environment: Readonly<Record<string, EnvironmentValue>>;
  // Whether a change that edits suite files also runs its own version, as a proposal pass.
  readonly runChangedTestsAsProposal: boolean;
  readonly keepTraces: boolean;
  // The suite's own screenshots are unmasked, so they are kept only on request, and never embedded.
  readonly keepSuiteScreenshots: boolean;
  readonly timeoutMilliseconds: number;
};

// The limits a suite's outputs are decoded under.
export type EvidenceLimits = {
  readonly maximumReportBytes: number;
  readonly maximumTests: number;
  readonly maximumTraceBytes: number;
  readonly maximumTraceEntries: number;
  readonly maximumAuditedPages: number;
  // How deeply the JSON report may nest. Present only when the project sets it; the report decoder
  // uses DEFAULT_REPORT_DEPTH otherwise.
  readonly maximumReportDepth?: number;
};

// The project's evidenceMode section. Absent means evidence mode is off.
export type EvidenceMode = { readonly suites: readonly EvidenceSuiteDeclaration[]; readonly limits: EvidenceLimits };

// ---- What a run vouches for ----------------------------------------------------------------------

export const GUARANTEE_IDS = [
  // Only closed, parsed plan steps acted on the page.
  'plan-closed',
  // The policy gate's runtime guard saw every action.
  'actions-guarded',
  // Elements were found by role, label, text or test id.
  'semantic-locators',
  // Every check reads what the page shows or exposes to assistive technology.
  'observable-checks',
  // Every request went through the egress proxy, which allows only declared origins.
  'egress-enforced',
  // The run's environment held no cloud, production or publishing credential.
  'no-ambient-credentials',
  // Secret values are replaced in every output.
  'secrets-redacted',
  // Personal data is masked in every image an output holds.
  'pii-masked',
  // Running the manifest again gives the same result hash.
  'replay-identical',
] as const;
export type GuaranteeId = (typeof GUARANTEE_IDS)[number];
// Why a guarantee does not hold.
//   evidence-mode: the run executed the team's own test code, which Revisum cannot vouch for.
//   egress-unenforceable: the run was not inside the isolated runner, so egress was not enforced.
//   an unsafe feature's name: the plan uses that feature, which gives the guarantee up.
export type GuaranteeLossReason = 'evidence-mode' | 'egress-unenforceable' | UnsafeFeature;
// The level is the summary: 'isolated' only when every guarantee holds.
export type GuaranteeStatement = {
  readonly level: GuaranteeLevel;
  readonly holds: readonly GuaranteeId[];
  readonly lost: readonly { readonly guarantee: GuaranteeId; readonly because: GuaranteeLossReason }[];
};

// ---- An evidence run's tests ---------------------------------------------------------------------

// How a run came about: a parsed plan, or a team's own suite.
export type RunMode = 'plan' | 'evidence';
// The gating pass runs the protected branch's suite files and may open the merge gate. The
// proposal pass runs the change's own version of them and never does.
export type SuitePass = 'gating' | 'proposal';
// expected-failure: a test the suite marked as expected to fail (Playwright's test.fail()) that
// failed. Playwright counts it as expected, but a person should look at why it is kept.
export type SuiteTestOutcome = 'passed' | 'failed' | 'timed-out' | 'skipped' | 'interrupted' | 'expected-failure';
// The sha256 of a test's file, title path and project.
export type SuiteTestId = Brand<string, 'SuiteTestId'>;
// Shown beside criterion ids that come from a suite's annotations: the suite's code makes the
// link, so Revisum reports it without vouching for it.
export const SUITE_CRITERION_LINK = 'linked by the suite';

export type SuiteTestResult = {
  readonly id: SuiteTestId;
  readonly file: SafeText;
  // The describe titles, then the test's own.
  readonly titlePath: readonly SafeText[];
  readonly project: SafeText;
  readonly outcome: SuiteTestOutcome;
  readonly pass: SuitePass;
  // From annotations of type "criterion".
  readonly criterionIds: readonly CriterionId[];
  // Present when there are criterion ids: who made the link.
  readonly criterionLink?: typeof SUITE_CRITERION_LINK;
  readonly findingIds: readonly string[];
  // Kept traces, kept suite screenshots and Revisum's own masked captures.
  readonly artefacts: readonly ArtifactReference[];
};

// Where in the suite's code a failure was raised.
export type SuiteLocation = { readonly file: SafeText; readonly line: number; readonly column: number };

// A failed or timed-out test, as a finding.
export type SuiteFinding = {
  readonly id: string;
  readonly testId: SuiteTestId;
  readonly status: 'fail';
  readonly criterionIds: readonly CriterionId[];
  readonly criterionLink?: typeof SUITE_CRITERION_LINK;
  // What the test did, from its trace's actions.
  readonly steps: readonly SafeText[];
  // The redacted error message, one entry per line.
  readonly message: readonly SafeText[];
  readonly location?: SuiteLocation;
};
