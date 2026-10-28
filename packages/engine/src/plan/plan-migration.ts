// Migration from version 1 of the plan language. Version 1 plans had no criterion ids on their
// assertions, so the author supplies one for each, keyed by the assertion step's JSON path, such
// as "$.steps[3]". The migration adds those ids and the new version and changes nothing else.
// An assertion with no entry fails with no_criterion_id, so nothing migrates silently.
// Version 1 plans are accepted this way for 12 months after version 1.1, and in no other way.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { failure, type CriterionId, type PlanData, type Result } from '@revisum/contracts';
import { DEFAULT_LIMITS } from '../project/project-parser.ts';
import { INVALID, peekRecord, readList, readRecord, type Issues, type PlanError } from './plan-decoders.ts';
import { ASSERTION_STEP_TYPES, CRITERION_FIELD, CURRENT_PLAN_VERSION, PLAN_FIELDS } from './plan-grammar.ts';
import { readPlanData } from './plan-parser.ts';

// The version number a version 1 plan declares.
const LEGACY_VERSION = 1;
// The steps version 1 had. A step added later in a version 1 plan is unknown, not migrated.
const LEGACY_STEP_TYPES: readonly unknown[] = ['navigate', 'click', 'fill', 'press', 'expect', 'expectPage', 'a11yAudit', 'capture'];

// The author's criterion id for each version 1 assertion, keyed by the assertion step's JSON path.
export type CriterionMapping = Readonly<Record<string, CriterionId>>;

// Checks the parts of a version 1 plan that version 1.1 reads differently: the version number,
// the step types of the time, and that each assertion has a criterion id in the mapping.
// Returns the plan in the current version, with each assertion's id added, still unparsed.
function addCriterionIds(legacyPlan: unknown, mapping: CriterionMapping, issues: PlanError[]): unknown {
  const planIssues: Issues = [];
  const fields = readRecord(legacyPlan, '$', planIssues, PLAN_FIELDS);
  if (fields === INVALID) { issues.push(...planIssues); return INVALID; }
  if (fields['version'] !== LEGACY_VERSION) planIssues.push({ code: 'version_unsupported', path: '$.version' });
  const steps = readList(fields['steps'], '$.steps', planIssues, DEFAULT_LIMITS.maximumSteps);
  issues.push(...planIssues);
  if (steps === INVALID || planIssues.length > 0) return INVALID;
  const migratedSteps = steps.map((step, index) => {
    const path = `$.steps[${index}]`;
    const stepIssues: Issues = [];
    const head = peekRecord(step, path, stepIssues);
    issues.push(...stepIssues);
    if (head === INVALID) return step;
    if (!LEGACY_STEP_TYPES.includes(head['type'])) { issues.push({ code: 'unknown_step', path: `${path}.type` }); return step; }
    if (!ASSERTION_STEP_TYPES.some((type) => type === head['type'])) return step;
    if (Object.hasOwn(head, CRITERION_FIELD)) { issues.push({ code: 'unknown_field', path: `${path}.${CRITERION_FIELD}` }); return step; }
    if (!Object.hasOwn(mapping, path)) { issues.push({ code: 'no_criterion_id', path }); return step; }
    return { ...head, [CRITERION_FIELD]: mapping[path] };
  });
  return { ...fields, version: CURRENT_PLAN_VERSION, steps: migratedSteps };
}

// Migrates a version 1 plan to the current language. Pure: the input and mapping are never
// changed, and the same input always gives the same output. The output is PlanData checked
// against the language only; it becomes a Plan only through the project's plan parser.
export function migratePlan(legacyPlan: unknown, mapping: CriterionMapping): Result<PlanData, readonly PlanError[]> {
  const issues: PlanError[] = [];
  const migrated = addCriterionIds(legacyPlan, mapping, issues);
  if (migrated === INVALID || issues.length > 0) return failure(issues);
  // Version 1 had no secrets, fixtures or frames, so none are declared here.
  return readPlanData(migrated, { origins: 'any', targetIds: 'any', secretNames: [], fixtures: [], limits: DEFAULT_LIMITS });
}
