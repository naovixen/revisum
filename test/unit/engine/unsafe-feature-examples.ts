// Shared setup for the tests of plan language 1.3's unsafe features: projects that enable some of
// them, the plan parser for those projects, the gate's guarantee statement for a set of features,
// and a run of an unsafe plan on a driver that needs no browser. The plan parts and declarations
// themselves are in unsafe-feature-steps.ts.
//
// The shapes the spec left open are settled in its Build notes; these tests rely on them:
//   - a disabled feature is reported at the field that names it: a locator's `by`, an assertion's
//     `kind`, a remember source's `read`, a step's `type`; an inline script at `.script.inline`;
//   - a database service is declared as { name, origin, private, port };
//   - guaranteeStatement's conditions gain `unsafeFeatures`, and each guarantee a feature loses is
//     listed in `lost` with that feature as its reason;
//   - run() takes the named scripts' sources as `scriptSources`, keyed by each declared file path;
//   - a closed plan's result and manifest carry no unsafe field at all, so their hashes are those
//     of before plan 1.3 (unsafe-feature-closed-plans-unchanged.test.ts);
//   - in M1 a run of a plan with page scripts or database commands still builds its manifest, and
//     reports those steps as unsupported-step.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import {
  defaultRedactor, guaranteeStatement, parseProject, planParser, run, unsafeFeaturesOf,
  type GuaranteeId, type GuaranteeStatement, type Plan, type PlanError, type PlanStanding, type Project, type Result, type RunResult,
  type UnsafeFeature,
} from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import { DEFAULT_CLOCK_START, DEFAULT_SEED, recordingDriver, type Recording } from './run-value-examples.ts';
import { FEATURES, ORIGIN, SCRIPT_SOURCES, unsafeProjectFile, type FeatureName, type JsonRecord } from './unsafe-feature-steps.ts';

export type ParsePlan = (input: unknown) => Result<Plan, readonly PlanError[]>;

export function parsedProject(projectFile: unknown): Project {
  const parsed = parseProject(projectFile);
  assert.ok(parsed.ok, `the project was rejected: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

// The plan parser of a project enabling exactly `enabled`, every feature by default.
export const parserEnabling = (enabled: readonly FeatureName[] = FEATURES, fields: JsonRecord = {}): ParsePlan =>
  planParser(parsedProject(unsafeProjectFile(enabled, fields)));

// Every feature but `feature`. Without page scripts there is no pageScripts entry, so inline
// scripts are off too.
export const allBut = (feature: FeatureName): readonly FeatureName[] =>
  FEATURES.filter((other) => other !== feature && !(feature === 'page-script' && other === 'inline-page-script'));

export function acceptedBy(parse: ParsePlan, raw: unknown): Plan {
  const parsed = parse(raw);
  assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

// The errors of a rejected plan, as returned.
export function errorsOf(parse: ParsePlan, raw: unknown): readonly PlanError[] {
  const parsed = parse(raw);
  assert.equal(parsed.ok, false, 'the plan was accepted');
  return parsed.ok ? [] : parsed.error;
}

// The errors of a rejected plan as "code path" lines, in the parser's order.
export const rejection = (parse: ParsePlan, raw: unknown): string[] => errorsOf(parse, raw).map((error) => `${error.code} ${error.path}`);

// The paths of the unsafe_feature_disabled errors, sorted, and each only once.
export const disabledPaths = (errors: readonly PlanError[]): string[] =>
  [...new Set(errors.filter((error) => error.code === 'unsafe_feature_disabled').map((error) => error.path))].sort();

export const featuresOf = (plan: Plan): readonly UnsafeFeature[] => unsafeFeaturesOf(plan);

// ---- What each feature costs ------------------------------------------------------------------------

// The guarantees each feature loses, from the spec's table, and only those.
export const LOST_BY_FEATURE: Readonly<Record<FeatureName, readonly GuaranteeId[]>> = {
  'css-locator': ['semantic-locators'],
  'xpath-locator': ['semantic-locators'],
  'dom-checks': ['observable-checks'],
  'page-script': ['plan-closed', 'actions-guarded', 'observable-checks', 'pii-masked'],
  'inline-page-script': ['plan-closed', 'actions-guarded', 'observable-checks', 'pii-masked'],
  'database-command': ['plan-closed', 'actions-guarded', 'replay-identical'],
};

// The guarantees a set of features loses together.
export const lostBy = (features: readonly FeatureName[]): GuaranteeId[] =>
  [...new Set(features.flatMap((feature) => LOST_BY_FEATURE[feature]))].sort();

// The gate's statement for a plan run with these features. egressEnforced says whether the run was
// inside the isolated runner; with it, a closed plan run keeps every guarantee.
export const statementFor = (features: readonly UnsafeFeature[], egressEnforced: boolean): GuaranteeStatement =>
  guaranteeStatement({ mode: 'plan', egressEnforced, unmaskedScreenshotsKept: false, unsafeFeatures: features });

export const lostIds = (statement: GuaranteeStatement): string[] => [...new Set(statement.lost.map((entry) => entry.guarantee))].sort();

// The reasons the statement gives for losing `guarantee`.
export const reasonsFor = (statement: GuaranteeStatement, guarantee: GuaranteeId): string[] =>
  statement.lost.filter((entry) => entry.guarantee === guarantee).map((entry) => entry.because).sort();

// The guarantees lost because of an unsafe feature, whatever else was lost.
export const lostToFeatures = (statement: GuaranteeStatement): string[] =>
  [...new Set(statement.lost.filter((entry) => (FEATURES as readonly string[]).includes(entry.because)).map((entry) => entry.guarantee))].sort();

// ---- Runs ---------------------------------------------------------------------------------------

export const sourceBytes = (sources: Readonly<Record<string, string>> = SCRIPT_SOURCES): Readonly<Record<string, Uint8Array>> =>
  Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, new TextEncoder().encode(text)]));

export type UnsafeRunOptions = {
  readonly projectFile?: JsonRecord;
  readonly scriptSources?: Readonly<Record<string, string>>;
  readonly standing?: PlanStanding;
  readonly seed?: number;
};

// Parses `raw` against the project file (every feature enabled by default), clears it through the
// policy gate and runs it on the project's target with a fresh recording driver.
export async function runUnsafePlan(raw: unknown, options: UnsafeRunOptions = {}): Promise<{ readonly result: RunResult; readonly recording: Recording }> {
  const projectFile = options.projectFile ?? unsafeProjectFile();
  const project = parsedProject(projectFile);
  const plan = acceptedBy(planParser(project), raw);
  const trusted = await trustedProjectFrom(projectFile);
  const target = project.matrix[0];
  assert.ok(target !== undefined, 'the test project has a target');
  const { driver, recording } = recordingDriver();
  const result = await run({
    plan: authorise(plan, trusted, options.standing), project, targetId: target.id, baseUrl: ORIGIN,
    seed: options.seed ?? DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START, fixtures: [], host: { platform: 'test', arch: 'test' },
    scriptSources: sourceBytes(options.scriptSources),
    ...(options.standing === undefined ? {} : { standing: options.standing }),
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock: systemClock, artifacts: memoryArtifactStore(),
    redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
  });
  return { result, recording };
}

// The run's manifest, which every run that opened its browser has.
export function manifestOf(result: RunResult): NonNullable<RunResult['manifest']> {
  assert.ok(result.manifest !== null, `the run has no manifest: ${result.state}`);
  return result.manifest;
}
