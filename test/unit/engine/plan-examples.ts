// The plan examples the plan-language tests share, read from disk so every test sees the same
// bytes:
//   - golden/plans/*.json: plans in versions "1.1" and "1.2", in which every assertion carries
//     the id of the acceptance criterion it checks;
//   - fixtures/plan-migration/<name>.plan.json: the same plans as first written in version 1,
//     before assertions carried criterion ids, with <name>.mapping.json giving each assertion's
//     criterion id, keyed by the assertion step's JSON path.
// Each loader returns a fresh copy, so a test may change it freely.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject, planParser, type Project } from '@revisum/engine';
import { FIXTURES, GOLDEN } from '../../support/repository.ts';

export const ORIGIN = 'http://127.0.0.1:4173';
export const TARGET_ID = 'playwright-chromium';
// The version the SPEC-01 examples are written in; version 1.2 still parses them unchanged.
export const CURRENT_VERSION = '1.1';

// A JSON object as read from disk, before any parsing.
export type JsonRecord = Record<string, unknown>;

const PLAN_FOLDER = join(GOLDEN, 'plans');
const MIGRATION_FOLDER = join(FIXTURES, 'plan-migration');

const readJson = (path: string): JsonRecord => JSON.parse(readFileSync(path, 'utf8'));

export const goldenPlanNames = (): readonly string[] =>
  readdirSync(PLAN_FOLDER).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();

export const migrationExampleNames = (): readonly string[] =>
  readdirSync(MIGRATION_FOLDER).filter((name) => name.endsWith('.plan.json')).map((name) => name.slice(0, -'.plan.json'.length)).sort();

export const goldenPlan = (name: string): JsonRecord => readJson(join(PLAN_FOLDER, `${name}.json`));
export const legacyPlan = (name: string): JsonRecord => readJson(join(MIGRATION_FOLDER, `${name}.plan.json`));
export const criterionMapping = (name: string): Readonly<Record<string, string>> =>
  readJson(join(MIGRATION_FOLDER, `${name}.mapping.json`)) as Record<string, string>;

// The sign-up plan in the current language. Its steps, by index:
//   0 navigate, 1 expect (visible), 2 expectPage (title), 3 fill, 4 fill, 5 expect (valueEquals),
//   6 capture, 7 click, 8 click, 9 expect (textContains), 10 expect (textContains), 11 a11yAudit, 12 capture.
export const signupPlan = (): JsonRecord => goldenPlan('signup');

// A plan that uses the steps the current language added. Its steps, by index:
//   0 navigate, 1 hover, 2 select, 3 frame (0 fill, 1 expect), 4 click, 5 dialog, 6 expect (absent), 7 expectPage.
export const accountClosurePlan = (): JsonRecord => goldenPlan('account-closure');

// A trusted project with one target, whose limits a test may tighten and to which a test may add
// other project fields, such as declared secret names and fixtures.
export const testProjectInput = (limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {}): JsonRecord => ({
  origins: [ORIGIN],
  limits: { stepTimeoutMilliseconds: 2000, ...limits },
  matrix: [{
    id: TARGET_ID, adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
    locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce',
  }],
  ...fields,
});

export function testProject(limits: Readonly<Record<string, number>> = {}, fields: JsonRecord = {}): Project {
  const parsed = parseProject(testProjectInput(limits, fields));
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const defaultParser = () => planParser(testProject());

// A deep copy of `input` with the value at `path` replaced, or removed when `value` is REMOVE.
// Each segment is an object key or an array index.
export const REMOVE: unique symbol = Symbol('remove');
export function withValue(input: unknown, path: readonly (string | number)[], value: unknown): JsonRecord {
  const copy: JsonRecord = structuredClone(input) as JsonRecord;
  let holder: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    holder = (holder as Record<string | number, unknown>)[segment];
    if (typeof holder !== 'object' || holder === null) throw new Error(`no object at ${String(segment)} in ${path.join('.')}`);
  }
  const last = path.at(-1);
  if (last === undefined) throw new Error('an empty path names no value');
  const target = holder as Record<string | number, unknown>;
  if (value === REMOVE) delete target[last];
  else target[last] = value;
  return copy;
}

// The steps of a raw plan, for tests that rebuild the step list.
export const stepsOf = (plan: JsonRecord): JsonRecord[] => plan['steps'] as JsonRecord[];

// A text no error message may contain: it stands for the private or hostile value in a plan.
export const PRIVATE_MARKER = 'private-marker-q7zx';
