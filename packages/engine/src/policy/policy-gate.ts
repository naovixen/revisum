// The policy gate: parsing stops invalid plans; this gate narrows what a valid plan may do. It is
// a mitigation, not the bound: the bound is non-production origins with disposable data.
//
//   - decide() is the static check, made before a run starts. It reads the plan's navigations and
//     the locator names of its clicks, its size against the trusted limits, and its targets'
//     locales. Only an allow decision carries an Authorised plan, the only kind run() accepts.
//   - guardAction() is the runtime guard. The driver calls it just before every action, with the
//     element the locator resolved to and any open dialog's text, so it sees what the plan alone
//     cannot: the name behind a test id, the form a key press would submit, where a link leads.
//
// Both are deterministic and read nothing but their arguments and the project. Each denial appends
// one plan.denied audit event whose code is the rule, so a denial leaves a record even when
// nothing ran.
// See docs/specs/SPEC-03-policy-gate.md.
import { literalText } from '@revisum/contracts';
import type {
  AllowedUrl, Authorised, EventSink, GuardVerdict, Locale, Locator, PathTemplate, Plan, PolicyDecision, PolicyRuleId, ResolvedElement,
  Step, Target, TargetId,
} from '@revisum/contracts';
import { deriveActor, sourceActorId } from '../actor.ts';
import type { PlanStanding } from '../approval/plan-standing.ts';
import { planHash } from '../manifest.ts';
import type { Limits, Project, ProjectPolicy } from '../project/project-parser.ts';
import type { TrustedProject } from '../project/trusted-project.ts';
import { isAllowedName, matchesIrreversiblePattern, patternsForLocale } from './irreversible-patterns.ts';

export interface PolicyGate {
  // The static check of a whole plan for the targets it will run on. A missing standing is a proposal.
  decide(plan: Plan, targets: readonly Target[], standing?: PlanStanding): PolicyDecision;
  // The runtime check of one action. A step that acts on no element, such as a dialog step,
  // passes an element with every field null.
  guardAction(step: Step, stepIndex: number, element: ResolvedElement, dialogText: string | null, locale: Locale): GuardVerdict;
}

export type PolicyGateOptions = {
  // The person-written project whose origins, limits and policy the gate applies.
  readonly project: Project | TrustedProject;
  readonly events: EventSink;
};

type Denial = { readonly rule: PolicyRuleId; readonly stepIndex: number | null };

// The gate does not know who wrote the plan it denies, so its events carry no person.
const POLICY_GATE_ACTOR = deriveActor(sourceActorId('policy gate'), 'unverified');

// Keys that press a focused control or submit the form around a focused field. Held modifiers
// do not change that: Control+Enter and Shift+Enter submit many forms, so a chord is judged by
// its key alone.
const ACTIVATING_KEYS: readonly string[] = ['Enter', 'Space'];

// Only used to read the path of a URL that is relative to the app under test.
const RELATIVE_BASE = new URL('https://relative.invalid');

// Every plan the gate authorised, with the targets it authorised it for, so run() can refuse a
// plan that was only cast to Authorised. A WeakMap holds no plan alive and cannot be listed.
const AUTHORISED_TARGETS = new WeakMap<object, Set<string>>();

// The one place a plan becomes Authorised: after decide() found nothing to deny.
function authorised(plan: Plan, targets: readonly Target[]): Authorised {
  const known = AUTHORISED_TARGETS.get(plan) ?? new Set<string>();
  for (const target of targets) known.add(target.id);
  AUTHORISED_TARGETS.set(plan, known);
  return plan as Authorised;
}

// The run-time half of the Authorised brand: run() calls this before acting on a plan for a
// target, so a plan the gate never cleared for that target is refused, whatever its type says.
export function assertAuthorised(plan: unknown, targetId: TargetId): asserts plan is Authorised {
  const known = typeof plan === 'object' && plan !== null ? AUTHORISED_TARGETS.get(plan) : undefined;
  if (known === undefined || !known.has(targetId)) {
    throw new TypeError('refused a plan that the policy gate did not authorise for this target');
  }
}

// ---- Shared rules -------------------------------------------------------------------------------

// A path compared the way servers commonly read it: percent-decoded, case-insensitive, with
// repeated and trailing slashes removed, so "/Account//%64elete/" still reads as /account/delete.
function comparablePath(path: string): string {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* malformed escapes: compare as written */ }
  return decoded.toLowerCase().replace(/\/+/gu, '/').replace(/\/$/u, '');
}

// True when `path` is a destructive path or continues one after a "/".
function isDestructivePath(path: string, policy: ProjectPolicy): boolean {
  const visited = comparablePath(path);
  return policy.destructiveUrlPatterns.some((pattern) => {
    const destructive = comparablePath(pattern);
    return visited === destructive || visited.startsWith(`${destructive}/`);
  });
}

// The URL a plan or a link names, read once. Relative URLs have no origin of their own.
function readUrl(url: string): { readonly origin: string | null; readonly path: string } | null {
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    return { origin: parsed.origin === RELATIVE_BASE.origin ? null : parsed.origin, path: parsed.pathname };
  } catch {
    return null;
  }
}

const isBlank = (text: string | null): boolean => text === null || text.trim() === '';

// The accessible name a locator asks for, when the plan itself says it. A test id names no text,
// and a value reference has none until the run; the runtime guard then sees the element's name.
function locatorName(locator: Locator): string | null {
  const name = locator.by === 'role' ? locator.name : locator.by === 'label' ? locator.label : locator.by === 'text' ? locator.text : null;
  return name === null ? null : literalText(name) ?? null;
}

// The part of a path template the plan fixes: its literal segments up to the first value. A
// destructive path there is destructive whatever the values are; the runtime guard checks the
// whole URL once the values are known.
function literalPathOf(template: PathTemplate): string {
  const literal: string[] = [];
  for (const segment of template.segments) {
    const text = literalText(segment);
    if (text === undefined) break;
    literal.push(text);
  }
  return `/${literal.join('/')}`;
}

// The URL a navigate step names, as far as the plan alone says it.
const navigationUrl = (url: AllowedUrl | PathTemplate): string => (typeof url === 'string' ? url : literalPathOf(url));

// The steps a plan holds, including those inside frames, each with the index of its top-level step.
function everyStep(steps: readonly Step[], topIndex?: number): { readonly step: Step; readonly index: number }[] {
  return steps.flatMap((step, index) => {
    const own = { step, index: topIndex ?? index };
    return step.type === 'frame' ? [own, ...everyStep(step.steps, own.index)] : [own];
  });
}

// ---- The static check ---------------------------------------------------------------------------

// The same limits the plan parser applies, checked again against the trusted project, so a plan
// parsed under looser settings is still held to the trusted ones.
function isOverLimit(plan: Plan, limits: Limits): boolean {
  const listTooLong = (steps: readonly Step[], depth: number): boolean =>
    steps.length > limits.maximumSteps
    || steps.some((step) => step.type === 'frame' && (depth + 1 > limits.maximumFrameDepth || listTooLong(step.steps, depth + 1)));
  const bytes = new TextEncoder().encode(JSON.stringify(plan)).length;
  return bytes > limits.maximumPlanBytes || listTooLong(plan.steps, 0);
}

type StaticContext = {
  readonly project: Project | TrustedProject;
  readonly patterns: readonly string[];
  readonly productionAllowed: boolean;
};

function navigationRule(url: string, context: StaticContext): PolicyRuleId | null {
  const read = readUrl(url);
  // The parser has already accepted the URL, so this cannot happen; deny rather than guess.
  if (read === null) return 'undeclared-origin';
  if (read.origin !== null) {
    if (!context.project.origins.some((origin) => origin === read.origin)) return 'undeclared-origin';
    if (!context.productionAllowed && context.project.productionOrigins.some((origin) => origin === read.origin)) return 'production-origin';
  }
  return isDestructivePath(read.path, context.project.policy) ? 'destructive-navigation' : null;
}

// True when the name marks an irreversible action the project has not allowed by name.
const isIrreversibleName = (name: string, patterns: readonly string[], policy: ProjectPolicy): boolean =>
  matchesIrreversiblePattern(name, patterns) && !isAllowedName(name, policy.allowedIrreversibleNames);

function staticRule(step: Step, context: StaticContext): PolicyRuleId | null {
  if (step.type === 'navigate') return navigationRule(navigationUrl(step.url), context);
  if (step.type === 'click') {
    const name = locatorName(step.locator);
    if (name !== null && isIrreversibleName(name, context.patterns, context.project.policy)) return 'irreversible-action';
  }
  return null;
}

function staticDenial(plan: Plan, targets: readonly Target[], standing: PlanStanding, project: Project | TrustedProject): Denial | null {
  if (isOverLimit(plan, project.limits)) return { rule: 'over-limit', stepIndex: null };
  const patternSets = targets.map((target) => patternsForLocale(target.locale, project.policy.irreversiblePatterns));
  const patterns: string[] = [];
  for (const set of patternSets) {
    if (set === null) return { rule: 'no-locale-patterns', stepIndex: null };
    patterns.push(...set);
  }
  // Production is closed to every plan unless the project opens it, and then only to approved plans.
  const productionAllowed = standing.mode === 'approved' && project.policy.allowProductionForApprovedPlans;
  const context: StaticContext = { project, patterns, productionAllowed };
  for (const { step, index } of everyStep(plan.steps)) {
    const rule = staticRule(step, context);
    if (rule !== null) return { rule, stepIndex: index };
  }
  return null;
}

// ---- The runtime guard --------------------------------------------------------------------------

// A control with no accessible name could be anything, so it is acted on only when the project
// allows it by test id, either the one the locator used or the element's own.
function isAllowedUnnamed(locator: Locator, element: ResolvedElement, policy: ProjectPolicy): boolean {
  const allowed = policy.unnamedControlsAllowedByTestId;
  const testId = locator.by === 'testId' ? literalText(locator.testId) : undefined;
  return (testId !== undefined && allowed.includes(testId))
    || (element.testId !== undefined && allowed.some((testId) => testId === element.testId));
}

function linkRule(element: ResolvedElement, policy: ProjectPolicy): PolicyRuleId | null {
  if (element.linkUrl === null) return null;
  const read = readUrl(element.linkUrl);
  return read !== null && isDestructivePath(read.path, policy) ? 'destructive-navigation' : null;
}

function runtimeRule(
  step: Step, element: ResolvedElement, dialogText: string | null, patterns: readonly string[], project: Project | TrustedProject,
): PolicyRuleId | null {
  const policy = project.policy;
  const irreversible = (text: string | null): boolean => text !== null && isIrreversibleName(text, patterns, policy);
  switch (step.type) {
    case 'dialog':
      return step.action === 'accept' && irreversible(dialogText) ? 'irreversible-dialog' : null;
    case 'navigate': {
      // Production depends on the plan's standing, which only the static check has. The run
      // passes a path template here with its values already in place.
      const read = readUrl(navigationUrl(step.url));
      if (read === null || (read.origin !== null && !project.origins.some((origin) => origin === read.origin))) return 'undeclared-origin';
      return isDestructivePath(read.path, policy) ? 'destructive-navigation' : null;
    }
    case 'click': case 'hover': case 'fill': case 'select': case 'upload': case 'press': {
      if (isBlank(element.name) && !isAllowedUnnamed(step.locator, element, policy)) return 'unnamed-control';
      if (step.type === 'click') return irreversible(element.name) ? 'irreversible-action' : linkRule(element, policy);
      if (step.type !== 'press' || !ACTIVATING_KEYS.includes(step.key)) return null;
      // Enter or Space presses a focused button or link as a click would, and submits the form
      // around a focused field.
      if (irreversible(element.name)) return 'irreversible-action';
      return linkRule(element, policy) ?? (irreversible(element.formSubmitName) ? 'irreversible-submit' : null);
    }
    case 'frame': case 'expect': case 'expectPage': case 'a11yAudit': case 'capture': case 'remember':
      return null;
  }
}

// ---- The gate -----------------------------------------------------------------------------------

export function policyGate(options: PolicyGateOptions): PolicyGate {
  const { project, events } = options;
  // The audit record is appended whether or not the sink accepts it: the decision stands either way.
  const record = (rule: PolicyRuleId, plan?: Plan): void => {
    events.append({ kind: 'plan.denied', code: rule, ...(plan === undefined ? {} : { subjectHash: planHash(plan) }) }, POLICY_GATE_ACTOR);
  };
  return {
    decide(plan, targets, standing = { mode: 'proposal' }) {
      const denial = staticDenial(plan, targets, standing, project);
      if (denial === null) return { kind: 'allow', plan: authorised(plan, targets) };
      record(denial.rule, plan);
      return { kind: 'deny', rule: denial.rule, stepIndex: denial.stepIndex };
    },
    guardAction(step, stepIndex, element, dialogText, locale) {
      const patterns = patternsForLocale(locale, project.policy.irreversiblePatterns);
      const rule = patterns === null ? 'no-locale-patterns' : runtimeRule(step, element, dialogText, patterns, project);
      if (rule === null) return { kind: 'allow' };
      record(rule);
      return { kind: 'deny', rule, stepIndex };
    },
  };
}
