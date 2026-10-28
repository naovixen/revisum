// Shared setup for the tests of plan language 1.2: run values (generated and remembered), path
// templates, the plan clock, positions, declared test-id attributes, key chords, multi-line text
// and the URL-prefix check.
//
//   - planOf() builds a raw plan declaring "1.2" around the given steps, ending with one check;
//   - parserFor() parses against the shared test project (plan-examples.ts), with any 1.2
//     project fields a test adds, such as testIdAttributes or generatedEmailDomains;
//   - runPlan() runs a parsed plan through the policy gate and run() on a driver that needs no
//     browser and records every call, so a test can see what reached the page.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import {
  defaultRedactor, parseProject, planParser, run,
  type ActionStep, type BrowserDriver, type ElementProbe, type GeneratedValue, type Plan, type PlanError, type Project,
  type Result, type RunResult, type Session, type SessionEnvironment, type ValueName,
} from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import { ORIGIN, TARGET_ID, testProjectInput, type JsonRecord } from './plan-examples.ts';

export { ORIGIN, TARGET_ID, type JsonRecord };

// The language version that holds every feature below.
export const NEW_VERSION = '1.2';
// The version before it, which must parse exactly as it always did.
export const PREVIOUS_VERSION = '1.1';

// The last step of every plan built here: a plan must check something.
export const CLOSING_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'orders.status-shown',
};

// A raw 1.2 plan: the given steps, then CLOSING_CHECK. `fields` adds or replaces top-level
// fields, such as `values` or `clock`. Step indexes are the given steps' indexes.
export const planOf = (steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: NEW_VERSION,
  meta: { featureId: 'ORDERS-1', specReference: 'specs/orders.md#new-order', title: 'New order' },
  targets: [TARGET_ID],
  steps: [...steps, CLOSING_CHECK],
  ...fields,
});

export const reference = (valueName: string): JsonRecord => ({ valueName });
export const label = (text: unknown): JsonRecord => ({ by: 'label', label: text });
export const navigate = (url: unknown): JsonRecord => ({ type: 'navigate', url });
export const OPEN_ORDERS: JsonRecord = navigate('/orders');

// The project file the plan parser reads: the shared test project plus 1.2 fields.
export const projectFileWith = (fields: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}): JsonRecord =>
  testProjectInput(limits, fields);

export function projectWith(fields: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}): Project {
  const parsed = parseProject(projectFileWith(fields, limits));
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export type ParsePlan = (input: unknown) => Result<Plan, readonly PlanError[]>;

export const parserFor = (fields: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}): ParsePlan =>
  planParser(projectWith(fields, limits));

// A plan the parser accepted. A rejection fails the test, showing the errors.
export function accepted(parse: ParsePlan, raw: unknown): Plan {
  const parsed = parse(raw);
  assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

// The errors of a rejected plan as "code path" lines, in the parser's order.
export function rejection(parse: ParsePlan, raw: unknown): string[] {
  const parsed = parse(raw);
  assert.equal(parsed.ok, false, 'the plan was accepted');
  return parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`);
}

// A value name as the plan parser brands it. Tests take the generated value itself from a parsed
// plan; only the name, a record key, has to be branded here.
export const valueName = (name: string): ValueName => name as ValueName;

// The generated value a parsed plan declares under `name`.
export function declaredValue(plan: Plan, name: string): GeneratedValue {
  const entries: [string, GeneratedValue][] = Object.entries(plan.values ?? {});
  const found = entries.find(([key]) => key === name);
  assert.ok(found !== undefined, `the plan declares no value named ${name}`);
  return found[1];
}

// ---- A driver that needs no browser -------------------------------------------------------------

// Everything the run asked of the page, in order.
export type Recording = {
  readonly environments: SessionEnvironment[];
  readonly navigations: string[];
  readonly actions: ActionStep[];
  probes: number;
};

const SHOWN: ElementProbe = { count: 1, visible: true, enabled: true, text: 'Ready', value: null, sensitive: false, box: null };

// The page title every recorded page shows.
export const PAGE_TITLE = 'Orders';

// A driver whose page accepts every action, shows one element for every locator and records
// every call. Its adapter id is the shared test project's.
export function recordingDriver(): { readonly driver: BrowserDriver; readonly recording: Recording } {
  const recording: Recording = { environments: [], navigations: [], actions: [], probes: 0 };
  const session: Session = {
    browser: { name: 'recording-browser', version: '1.0' },
    navigate: async (url) => { recording.navigations.push(url); return { ok: true, value: undefined }; },
    page: async () => ({ url: recording.navigations.at(-1) ?? `${ORIGIN}/`, title: PAGE_TITLE }),
    act: async (step) => { recording.actions.push(step); return { ok: true, value: undefined }; },
    probe: async () => { recording.probes++; return SHOWN; },
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    audit: async () => [],
    accessibilitySnapshot: async () => ({ role: 'document', name: '', children: [] }),
    blockedOrigins: () => [],
    close: async () => undefined,
  };
  const driver: BrowserDriver = {
    info: { id: 'playwright', version: 'recording', protocol: 'none' },
    supports: () => ({ ok: true, value: true }),
    open: async (_target, environment) => { recording.environments.push(environment); return { ok: true, value: session }; },
  };
  return { driver, recording };
}

export type RunOptions = {
  readonly projectFile?: JsonRecord;
  readonly seed?: number;
  readonly clockStartMilliseconds?: number;
  readonly baseUrl?: string;
};

export const DEFAULT_SEED = 7;
export const DEFAULT_CLOCK_START = Date.UTC(2026, 9, 28, 12, 0, 0);

// Parses `raw` against the project file, clears it through the policy gate and runs it on the
// first target of the project's matrix with a fresh recording driver.
export async function runPlan(raw: unknown, options: RunOptions = {}): Promise<{ readonly result: RunResult; readonly recording: Recording }> {
  const projectFile = options.projectFile ?? projectFileWith();
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad test project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const plan = accepted(planParser(project), raw);
  const trusted = await trustedProjectFrom(projectFile);
  const target = project.matrix[0];
  assert.ok(target !== undefined, 'the test project has a target');
  const { driver, recording } = recordingDriver();
  const result = await run({
    plan: authorise(plan, trusted), project, targetId: target.id, baseUrl: options.baseUrl ?? ORIGIN,
    seed: options.seed ?? DEFAULT_SEED, fixedTimeMilliseconds: options.clockStartMilliseconds ?? DEFAULT_CLOCK_START,
    fixtures: [], host: { platform: 'test', arch: 'test' },
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock: systemClock, artifacts: memoryArtifactStore(),
    redactor: defaultRedactor(), events: memoryRunEventSink(),
  });
  return { result, recording };
}
