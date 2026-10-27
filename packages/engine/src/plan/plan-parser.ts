// The plan parser: the only way to obtain a Plan. It rejects unknown fields and steps, origins
// off the allow-list, targets off the matrix, script-like text and oversized input, before any
// side effect. See docs/specs/SPEC-01-plan-language-and-parser.md.
import {
  KEYS, PLAN_VERSION, ROLES, failure, success,
  type AllowedUrl, type ElementAssertion, type Locator, type PageAssertion, type Plan, type PlanData, type PlanMeta,
  type Result, type SafeText, type Step, type StepType, type TargetId,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { readId, type Project } from '../project/project-parser.ts';
import {
  INVALID, allValid, peekRecord, readList, readOneOf, readRecord, readText,
  type Issues, type Parsed, type PlanError,
} from './plan-decoders.ts';

const STEP_FIELDS: { readonly [Type in StepType]: readonly string[] } = {
  navigate: ['type', 'url'],
  click: ['type', 'locator'],
  fill: ['type', 'locator', 'value'],
  press: ['type', 'locator', 'key'],
  expect: ['type', 'locator', 'assert'],
  expectPage: ['type', 'assert'],
  a11yAudit: ['type', 'mode'],
  capture: ['type', 'name'],
};
const STEP_TYPES = Object.keys(STEP_FIELDS) as StepType[];
const ELEMENT_KINDS = ['visible', 'hidden', 'enabled', 'disabled', 'textEquals', 'textContains', 'valueEquals'] as const;
const PAGE_KINDS = ['urlPath', 'title'] as const;
const KINDS_WITH_VALUE: readonly string[] = ['textEquals', 'textContains', 'valueEquals', 'urlPath', 'title'];
const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPTURE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A base used only to tell whether a URL is relative to the app under test.
const RELATIVE_BASE = new URL('https://relative.invalid');

type ParseContext = { readonly project: Project; readonly issues: Issues };

function readUrl(input: unknown, path: string, context: ParseContext): Parsed<AllowedUrl> {
  const text = readText(input, path, context.issues, 2048);
  if (text === INVALID) return INVALID;
  let url: URL;
  try { url = new URL(text, RELATIVE_BASE); } catch { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { context.issues.push({ code: 'scheme_not_allowed', path }); return INVALID; }
  if (url.username !== '' || url.password !== '') { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
  if (url.origin === RELATIVE_BASE.origin) {
    if (!text.startsWith('/')) { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
    return brand<string, 'AllowedUrl'>(url.pathname + url.search + url.hash);
  }
  if (!context.project.origins.some((origin) => origin === url.origin)) {
    context.issues.push({ code: 'origin_not_allowed', path });
    return INVALID;
  }
  return brand<string, 'AllowedUrl'>(url.href);
}

function readLocator(input: unknown, path: string, context: ParseContext): Parsed<Locator> {
  const longest = context.project.limits.maximumTextLength;
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const by = readOneOf(head['by'], `${path}.by`, context.issues, ['role', 'label', 'text', 'testId'] as const);
  if (by === INVALID) return INVALID;
  switch (by) {
    case 'role': {
      if (readRecord(input, path, context.issues, ['by', 'role', 'name']) === INVALID) return INVALID;
      const parts = [
        readOneOf(head['role'], `${path}.role`, context.issues, ROLES),
        readText(head['name'], `${path}.name`, context.issues, longest),
      ] as const;
      return allValid(parts) ? { by, role: parts[0], name: parts[1] } : INVALID;
    }
    case 'label': {
      if (readRecord(input, path, context.issues, ['by', 'label']) === INVALID) return INVALID;
      const label = readText(head['label'], `${path}.label`, context.issues, longest);
      return label === INVALID ? INVALID : { by, label };
    }
    case 'text': {
      if (readRecord(input, path, context.issues, ['by', 'text']) === INVALID) return INVALID;
      const text = readText(head['text'], `${path}.text`, context.issues, longest);
      return text === INVALID ? INVALID : { by, text };
    }
    case 'testId': {
      if (readRecord(input, path, context.issues, ['by', 'testId']) === INVALID) return INVALID;
      const testId = readText(head['testId'], `${path}.testId`, context.issues, 64);
      return testId === INVALID ? INVALID : { by, testId };
    }
  }
}

function readAssertion<Kind extends string>(
  input: unknown, path: string, context: ParseContext, kinds: readonly Kind[],
): Parsed<{ readonly kind: Kind; readonly value?: SafeText }> {
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, kinds);
  if (kind === INVALID) return INVALID;
  if (!KINDS_WITH_VALUE.includes(kind)) return readRecord(input, path, context.issues, ['kind']) === INVALID ? INVALID : { kind };
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  const value = readText(head['value'], `${path}.value`, context.issues, context.project.limits.maximumTextLength, 0);
  return value === INVALID ? INVALID : { kind, value };
}

function readStep(input: unknown, path: string, context: ParseContext): Parsed<Step> {
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const type = readOneOf(head['type'], `${path}.type`, context.issues, STEP_TYPES, 'unknown_step');
  if (type === INVALID) return INVALID;
  if (readRecord(input, path, context.issues, STEP_FIELDS[type]) === INVALID) return INVALID;
  const locator = (): Parsed<Locator> => readLocator(head['locator'], `${path}.locator`, context);
  switch (type) {
    case 'navigate': {
      const url = readUrl(head['url'], `${path}.url`, context);
      return url === INVALID ? INVALID : { type, url };
    }
    case 'click': {
      const found = locator();
      return found === INVALID ? INVALID : { type, locator: found };
    }
    case 'fill': {
      const parts = [locator(), readText(head['value'], `${path}.value`, context.issues, context.project.limits.maximumTextLength, 0)] as const;
      return allValid(parts) ? { type, locator: parts[0], value: parts[1] } : INVALID;
    }
    case 'press': {
      const parts = [locator(), readOneOf(head['key'], `${path}.key`, context.issues, KEYS)] as const;
      return allValid(parts) ? { type, locator: parts[0], key: parts[1] } : INVALID;
    }
    case 'expect': {
      const parts = [locator(), readAssertion(head['assert'], `${path}.assert`, context, ELEMENT_KINDS)] as const;
      return allValid(parts) ? { type, locator: parts[0], assert: parts[1] as ElementAssertion } : INVALID;
    }
    case 'expectPage': {
      const assertion = readAssertion(head['assert'], `${path}.assert`, context, PAGE_KINDS);
      return assertion === INVALID ? INVALID : { type, assert: assertion as PageAssertion };
    }
    case 'a11yAudit': {
      const mode = readOneOf(head['mode'], `${path}.mode`, context.issues, ['report', 'gate'] as const);
      return mode === INVALID ? INVALID : { type, mode };
    }
    case 'capture': {
      const name = head['name'];
      if (typeof name !== 'string' || !CAPTURE_NAME.test(name)) {
        context.issues.push({ code: 'unknown_value', path: `${path}.name` });
        return INVALID;
      }
      return { type, name: brand<string, 'CaptureName'>(name) };
    }
  }
}

function readMeta(input: unknown, path: string, context: ParseContext): Parsed<PlanMeta> {
  const fields = readRecord(input, path, context.issues, ['featureId', 'specReference', 'title']);
  if (fields === INVALID) return INVALID;
  const rawFeatureId = fields['featureId'];
  const featureId = typeof rawFeatureId === 'string' && FEATURE_ID.test(rawFeatureId) ? brand<string, 'FeatureId'>(rawFeatureId) : INVALID;
  if (featureId === INVALID) context.issues.push({ code: 'unknown_value', path: `${path}.featureId` });
  const parts = [
    featureId,
    readText(fields['specReference'], `${path}.specReference`, context.issues, 200),
    readText(fields['title'], `${path}.title`, context.issues, 120),
  ] as const;
  return allValid(parts) ? { featureId: parts[0], specReference: parts[1], title: parts[2] } : INVALID;
}

function sizeInBytes(input: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(input) ?? '').length; } catch { return Number.POSITIVE_INFINITY; }
}

function readTargetIds(input: unknown, context: ParseContext): readonly Parsed<TargetId>[] {
  const raw = readList(input, '$.targets', context.issues, Math.max(1, context.project.matrix.length));
  if (raw === INVALID) return [INVALID];
  const ids = raw.map((value, index) => {
    const path = `$.targets[${index}]`;
    const targetId = readId<'TargetId'>(value, path, context.issues);
    if (targetId === INVALID) return INVALID;
    if (!context.project.matrix.some((target) => target.id === targetId)) {
      context.issues.push({ code: 'target_not_in_matrix', path });
      return INVALID;
    }
    return targetId;
  });
  if (new Set(ids).size !== ids.length) context.issues.push({ code: 'duplicate', path: '$.targets' });
  return ids;
}

function readSteps(input: unknown, context: ParseContext): readonly Parsed<Step>[] {
  const raw = readList(input, '$.steps', context.issues, context.project.limits.maximumSteps);
  if (raw === INVALID) return [INVALID];
  const steps = raw.map((step, index) => readStep(step, `$.steps[${index}]`, context));
  const captureNames = steps.flatMap((step) => (step !== INVALID && step.type === 'capture' ? [step.name] : []));
  if (new Set(captureNames).size !== captureNames.length) context.issues.push({ code: 'duplicate', path: '$.steps' });
  return steps;
}

// Builds the parser for one trusted project.
export function planParser(project: Project): (input: unknown) => Result<Plan, readonly PlanError[]> {
  return function parsePlan(input) {
    if (sizeInBytes(input) > project.limits.maximumPlanBytes) return failure([{ code: 'too_large', path: '$' }]);
    const context: ParseContext = { project, issues: [] };
    const fields = readRecord(input, '$', context.issues, ['version', 'meta', 'targets', 'steps']);
    if (fields === INVALID) return failure(context.issues);
    if (fields['version'] !== PLAN_VERSION) context.issues.push({ code: 'version_unsupported', path: '$.version' });
    const meta = readMeta(fields['meta'], '$.meta', context);
    const targets = readTargetIds(fields['targets'], context);
    const steps = readSteps(fields['steps'], context);
    if (context.issues.length > 0 || meta === INVALID || !allValid(targets) || !allValid(steps)) return failure(context.issues);
    return success(brand<PlanData, 'Plan'>({ version: PLAN_VERSION, meta, targets, steps }));
  };
}
