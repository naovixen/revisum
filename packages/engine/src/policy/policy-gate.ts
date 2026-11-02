// The policy gate: parsing stops invalid plans; this gate narrows what a valid plan may do. It is
// a mitigation, not the bound: the bound is non-production origins with disposable data.
//
//   - decide() is the static check, made before a run starts. It reads the plan's navigations and
//     the locator names of its clicks, its size and number of calls against the trusted limits, its
//     targets' locales, what each declared call it makes may reach and change, and whether a
//     proposal starts a stub or writes storage its declaration keeps out of proposals. For the
//     unsafe plan features, it denies a proposal that holds an inline script or runs a write script
//     or command its declaration keeps out of proposals, and any database command whose service is
//     on a production origin. Whatever its standing, a plan is held to the features, scripts and
//     secrets this project declares, not those of the project it was parsed under. Only an allow
//     decision carries an Authorised plan, the only kind run() accepts.
//   - guardAction() is the runtime guard. The driver calls it just before every action, with the
//     element the locator resolved to and any open dialog's text, so it sees what the plan alone
//     cannot: the name behind a test id, the form a key press would submit, where a link leads.
//
// Both are deterministic and read nothing but their arguments and the project. Each denial appends
// one plan.denied audit event whose code is the rule, so a denial leaves a record even when
// nothing ran; a denial the audit sink failed to record is marked unrecorded. An authorisation
// holds only for the project and the standing it was cleared under: run() refuses it under any other.
import { literalText } from '@revisum/contracts';
import type {
  AllowedUrl, Authorised, CallArgument, DatabaseCommandStep, EventSink, GuardVerdict, Locale, Locator, PageScriptStep, PathTemplate, Plan, PolicyDecision,
  PolicyRuleId, RemoveStorageStep, ResolvedElement, SecretName, ServiceCallStep, SetStorageStep, Step, StubStep, Target, TargetId,
} from '@revisum/contracts';
import { deriveActor, sourceActorId } from '../actor.ts';
import { ownStanding, type PlanStanding } from '../approval/plan-standing.ts';
import { canonicalJson, sha256 } from '../hashing.ts';
import { planHash } from '../manifest.ts';
import { unsafeFeaturesOf } from '../plan/unsafe-features.ts';
import type { Limits, Project, ProjectPolicy } from '../project/project-parser.ts';
import type { TrustedProject } from '../project/trusted-project.ts';
import { declaredCommands, declaredScripts, enabledUnsafeFeatures } from '../project/unsafe-feature-declarations.ts';
import { everyIrreversiblePattern, isAllowedName, isBlankName, matchesIrreversiblePattern, patternsForLocale } from './irreversible-patterns.ts';

export interface PolicyGate {
  // The static check of a whole plan for the targets it will run on. A missing standing, or one
  // whose approval is for another plan's hash, is a proposal.
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

// How many times a path is decoded before the gate stops trusting what it can read of it. Each
// layer of encoding takes one round, and the last round only confirms nothing changed.
const MAXIMUM_DECODING_ROUNDS = 5;
const RUN_OF_ESCAPES = /(?:%[0-9a-f]{2})+/giu;
const UTF8 = new TextDecoder();

// Every plan the gate authorised, with each project, target and standing it authorised it for, so
// run() can refuse a plan that was only cast to Authorised, or that was cleared under another
// project's allowances or as a standing it no longer has. A WeakMap holds no plan alive and cannot
// be listed.
const AUTHORISED_CLEARANCES = new WeakMap<object, Set<string>>();

// What a project allows, as one hash over everything the gate reads from it. Where the project was
// read from (its provenance) allows nothing, so it is left out, and the same project file gives
// the same hash whether it was parsed or loaded from the protected branch.
function projectFingerprint(project: Project | TrustedProject): string {
  const allowances = Object.fromEntries(Object.entries(project).filter(([key]) => key !== 'provenance'));
  return sha256(canonicalJson(allowances));
}

const clearance = (projectHash: string, targetId: string, mode: PlanStanding['mode']): string => `${projectHash}:${targetId}:${mode}`;

// The one place a plan becomes Authorised: after decide() found nothing to deny.
function authorised(plan: Plan, targets: readonly Target[], projectHash: string, mode: PlanStanding['mode']): Authorised {
  const known = AUTHORISED_CLEARANCES.get(plan) ?? new Set<string>();
  for (const target of targets) known.add(clearance(projectHash, target.id, mode));
  AUTHORISED_CLEARANCES.set(plan, known);
  return plan as Authorised;
}

// The run-time half of the Authorised brand: run() calls this before acting on a plan for a
// target, so a plan the gate never cleared for that target, under exactly this project, is
// refused, whatever its type says. A plan cleared where "Delete account" is allowed cannot then
// run under a project that does not allow it.
export function assertAuthorised(plan: unknown, targetId: TargetId, project: Project | TrustedProject): asserts plan is Authorised {
  const known = typeof plan === 'object' && plan !== null ? AUTHORISED_CLEARANCES.get(plan) : undefined;
  const projectHash = projectFingerprint(project);
  if (known === undefined || !(known.has(clearance(projectHash, targetId, 'approved')) || known.has(clearance(projectHash, targetId, 'proposal')))) {
    throw new TypeError('refused a plan that the policy gate did not authorise for this target under this project');
  }
}

// True when the gate cleared this plan as this standing. A clearance as approved judged the plan's
// writes, inline scripts and barred stubs as allowed, which holds for no other standing.
export const isClearedForStanding = (plan: Authorised, targetId: TargetId, project: Project | TrustedProject, standing: PlanStanding): boolean =>
  AUTHORISED_CLEARANCES.get(plan)?.has(clearance(projectFingerprint(project), targetId, standing.mode)) === true;

// ---- Shared rules -------------------------------------------------------------------------------

// Each run of valid escapes decoded on its own, so a malformed escape stays as written and stops
// nothing. Bytes that are not UTF-8 become U+FFFD.
const withEscapesDecoded = (path: string): string =>
  path.replace(RUN_OF_ESCAPES, (run) => UTF8.decode(Uint8Array.from(run.split('%').slice(1), (escape) => Number.parseInt(escape, 16))));

// A path compared the way servers commonly read it: percent-decoded through every layer,
// case-insensitive, with path parameters and repeated and trailing slashes removed, so
// "/Account//%2564elete;x=1/" still reads as /account/delete. Null when it holds more layers than
// the gate will read.
function comparablePath(path: string): string | null {
  let decoded = path;
  for (let round = 0; round < MAXIMUM_DECODING_ROUNDS; round++) {
    const next = withEscapesDecoded(decoded);
    if (next === decoded) {
      return decoded.toLowerCase().replace(/;[^/]*/gu, '').replace(/\/+/gu, '/').replace(/\/$/u, '');
    }
    decoded = next;
  }
  return null;
}

// True when `path` is a destructive path or continues one after a "/". A path or pattern too deeply
// encoded to read might be one, so it counts as one.
function isDestructivePath(path: string, policy: ProjectPolicy): boolean {
  const visited = comparablePath(path);
  return visited === null || policy.destructiveUrlPatterns.some((pattern) => {
    const destructive = comparablePath(pattern);
    return destructive === null || visited === destructive || visited.startsWith(`${destructive}/`);
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

const isBlank = (text: string | null): boolean => text === null || isBlankName(text);

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

// The steps a plan holds, including those inside frames and second tabs, each with the index of
// its top-level step. A second tab's steps are judged exactly as the first tab's would be.
function everyStep(steps: readonly Step[], topIndex?: number): { readonly step: Step; readonly index: number }[] {
  return steps.flatMap((step, index) => {
    const own = { step, index: topIndex ?? index };
    return step.type === 'frame' || step.type === 'newTab' ? [own, ...everyStep(step.steps, own.index)] : [own];
  });
}

// ---- The static check ---------------------------------------------------------------------------

// The same limits the plan parser applies, checked again against the trusted project, so a plan
// parsed under looser settings is still held to the trusted ones.
function isOverLimit(plan: Plan, limits: Limits): boolean {
  // Frame depth counts from the tab, so a second tab's steps start at the depth of its own list.
  const listTooLong = (steps: readonly Step[], depth: number): boolean =>
    steps.length > limits.maximumSteps
    || steps.some((step) => (step.type === 'frame' && (depth + 1 > limits.maximumFrameDepth || listTooLong(step.steps, depth + 1)))
      || (step.type === 'newTab' && listTooLong(step.steps, depth)));
  const bytes = new TextEncoder().encode(JSON.stringify(plan)).length;
  const scripts = everyStep(plan.steps).filter(({ step }) => step.type === 'evaluate' || step.type === 'expectScript');
  return bytes > limits.maximumPlanBytes || listTooLong(plan.steps, 0) || externalCallSteps(plan).length + scripts.length > limits.maximumCalls;
}

// Every step that calls a service or runs a database command, the plan's steps first and its
// cleanup after, each with its step index, or null for a cleanup step, which no step index names.
// Both stand only at the top level, so frames and second tabs hold none. A check counts once,
// however often it polls.
function externalCallSteps(plan: Plan): { readonly step: ServiceCallStep | DatabaseCommandStep; readonly index: number | null }[] {
  const isExternal = (step: Step): step is ServiceCallStep | DatabaseCommandStep =>
    step.type === 'call' || step.type === 'expectBackend' || step.type === 'database' || step.type === 'expectDatabase';
  const steps = plan.steps.flatMap((step, index) => (isExternal(step) ? [{ step, index }] : []));
  return [...steps, ...(plan.cleanup ?? []).map((step) => ({ step, index: null }))];
}

// What a call may not do: reach a production service the plan's standing does not open, or, in a
// proposal, change something unless its declaration allows it in proposals. A call the project
// does not declare, or whose service it does not declare, reaches somewhere nobody declared.
function callRule(step: ServiceCallStep, context: StaticContext): PolicyRuleId | null {
  const declaration = Object.entries(context.project.calls).find(([name]) => name === step.call)?.[1];
  const service = context.project.services.find((candidate) => candidate.name === declaration?.service);
  if (declaration === undefined || service === undefined) return 'undeclared-origin';
  if (!context.productionAllowed && context.project.productionOrigins.some((origin) => origin === service.origin)) return 'production-origin';
  if (!context.approved && declaration.effect === 'write' && !declaration.allowInProposals) return 'side-effect-in-proposal';
  return null;
}

// What a database command may not do: reach a service on a production origin, whatever the plan's
// standing, since the gate cannot judge what the team's program does there; or, in a proposal,
// change something unless its declaration allows it in proposals.
function commandRule(step: DatabaseCommandStep, context: StaticContext): PolicyRuleId | null {
  const declaration = Object.entries(declaredCommands(context.project.unsafeFeatures)).find(([name]) => name === step.command)?.[1];
  const service = context.project.services.find((candidate) => candidate.name === declaration?.service);
  if (declaration === undefined || service === undefined) return 'undeclared-origin';
  if (context.project.productionOrigins.some((origin) => origin === service.origin)) return 'production-origin';
  if (!context.approved && declaration.effect === 'write' && !declaration.allowInProposals) return 'side-effect-in-proposal';
  return null;
}

const externalCallRule = (step: ServiceCallStep | DatabaseCommandStep, context: StaticContext): PolicyRuleId | null =>
  (step.type === 'call' || step.type === 'expectBackend' ? callRule(step, context) : commandRule(step, context));

// What a page script may not do: run undeclared, whatever the plan's standing, since a script the
// project does not declare is no one's. And in a proposal: be written into the plan, since its source
// and its claimed effect are the plan's own and no person declared them; or change something unless
// its declaration allows it in proposals.
function scriptRule(step: PageScriptStep, context: StaticContext): PolicyRuleId | null {
  if (typeof step.script !== 'string') {
    return context.approved ? null : 'inline-script-in-proposal';
  }
  const name = step.script;
  const declaration = Object.entries(declaredScripts(context.project.unsafeFeatures)).find(([declared]) => declared === name)?.[1];
  if (declaration === undefined) return 'undeclared-origin';
  return !context.approved && declaration.effect === 'write' && !declaration.allowInProposals ? 'side-effect-in-proposal' : null;
}

type StaticContext = {
  readonly project: Project | TrustedProject;
  readonly patterns: readonly string[];
  readonly productionAllowed: boolean;
  // False for a proposal: a plan with no approval.
  readonly approved: boolean;
};

// What a stub start or a storage write may not do: in a proposal, fake a response or change the
// page's storage unless its declaration allows it in proposals. Removing an entry is a write too.
// Stopping a stub undoes a side effect, so it is never one. A name the project does not declare
// reaches something nobody declared.
function sideEffectRule(step: StubStep | SetStorageStep | RemoveStorageStep, context: StaticContext): PolicyRuleId | null {
  const declaration = step.type === 'stub'
    ? Object.entries(context.project.stubs).find(([name]) => name === step.stub)?.[1]
    : Object.entries(context.project.storageEntries).find(([name]) => name === step.entry)?.[1];
  if (declaration === undefined) return 'undeclared-origin';
  const sideEffect = step.type !== 'stub' || step.action === 'start';
  return sideEffect && !context.approved && !declaration.allowInProposals ? 'side-effect-in-proposal' : null;
}

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
  // A second tab opens its URL as a navigate step would.
  if (step.type === 'navigate' || step.type === 'newTab') return navigationRule(navigationUrl(step.url), context);
  // A download is a click that must start a download, so it is judged as the click it is.
  if (step.type === 'click' || step.type === 'download') {
    const name = locatorName(step.locator);
    if (name !== null && isIrreversibleName(name, context.patterns, context.project.policy)) return 'irreversible-action';
  }
  if (step.type === 'stub' || step.type === 'setStorage' || step.type === 'removeStorage') return sideEffectRule(step, context);
  if (step.type === 'evaluate' || step.type === 'expectScript') return scriptRule(step, context);
  return null;
}

const secretNamesIn = (values: readonly (CallArgument | Extract<Step, { type: 'fill' }>['value'])[]): SecretName[] =>
  values.flatMap((value) => (typeof value === 'object' && 'secretName' in value ? [value.secretName] : []));

// The secrets the plan itself names, frames, second tabs and cleanup included. Those inside a
// declaration were held to the project when it was parsed.
function secretNamesOf(plan: Plan): readonly SecretName[] {
  const steps = [...everyStep(plan.steps).map(({ step }) => step), ...(plan.cleanup ?? [])];
  const named = steps.flatMap((step) => {
    if (step.type === 'fill') {
      return secretNamesIn([step.value]);
    }
    if (step.type === 'call' || step.type === 'expectBackend' || step.type === 'setStorage' || step.type === 'stub') {
      return secretNamesIn(Object.values(step.arguments ?? {}));
    }
    return [];
  });
  return plan.storageState === undefined ? named : [...named, plan.storageState.secretName];
}

// The parser judged these against the project it was given, which may not be the one clearing the
// plan. Plan-wide, before any step, so no standing can skip them.
function undeclaredUseRule(plan: Plan, project: Project | TrustedProject): PolicyRuleId | null {
  const enabled = enabledUnsafeFeatures(project.unsafeFeatures);
  if (unsafeFeaturesOf(plan).some((feature) => !enabled.includes(feature))) {
    return 'unsafe-feature-disabled';
  }
  return secretNamesOf(plan).some((name) => !project.secretNames.includes(name)) ? 'undeclared-secret' : null;
}

function staticDenial(plan: Plan, targets: readonly Target[], standing: PlanStanding, project: Project | TrustedProject): Denial | null {
  if (isOverLimit(plan, project.limits)) return { rule: 'over-limit', stepIndex: null };
  const undeclaredUse = undeclaredUseRule(plan, project);
  if (undeclaredUse !== null) {
    return { rule: undeclaredUse, stepIndex: null };
  }
  const patternSets = targets.map((target) => patternsForLocale(target.locale, project.policy.irreversiblePatterns));
  // With no targets no language is known, so every pattern applies: the engine's own never lapse.
  const patterns: string[] = targets.length === 0 ? [...everyIrreversiblePattern(project.policy.irreversiblePatterns)] : [];
  for (const set of patternSets) {
    if (set === null) return { rule: 'no-locale-patterns', stepIndex: null };
    patterns.push(...set);
  }
  // Production is closed to every plan unless the project opens it, and then only to approved plans.
  // The standing is already the plan's own (ownStanding), never another plan's.
  const productionAllowed = standing.mode === 'approved' && project.policy.allowProductionForApprovedPlans;
  const context: StaticContext = { project, patterns, productionAllowed, approved: standing.mode === 'approved' };
  for (const { step, index } of everyStep(plan.steps)) {
    const rule = staticRule(step, context);
    if (rule !== null) return { rule, stepIndex: index };
  }
  for (const { step, index } of externalCallSteps(plan)) {
    const rule = externalCallRule(step, context);
    if (rule !== null) return { rule, stepIndex: index };
  }
  return null;
}

// ---- The runtime guard --------------------------------------------------------------------------

// A control with no accessible name could be anything, so it is acted on only when the project
// allows it by test id, either the one the locator used or the element's own, or, for a css or
// XPath locator, by that exact selector or expression in its unsafe features' list.
function isAllowedUnnamed(locator: Locator, element: ResolvedElement, project: Project | TrustedProject): boolean {
  const allowed = project.policy.unnamedControlsAllowedByTestId;
  const testId = locator.by === 'testId' ? literalText(locator.testId) : undefined;
  const structural = locator.by === 'css' ? locator.selector : locator.by === 'xpath' ? locator.expression : undefined;
  return (testId !== undefined && allowed.includes(testId))
    || (element.testId !== undefined && allowed.some((testId) => testId === element.testId))
    || (structural !== undefined && (project.unsafeFeatures?.unnamedControlsAllowed ?? []).includes(structural));
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
    case 'navigate': case 'newTab': {
      // Production depends on the plan's standing, which only the static check has. The run
      // passes a path template here with its values already in place. A second tab opens its URL
      // as a navigate step would.
      const read = readUrl(navigationUrl(step.url));
      if (read === null || (read.origin !== null && !project.origins.some((origin) => origin === read.origin))) return 'undeclared-origin';
      return isDestructivePath(read.path, policy) ? 'destructive-navigation' : null;
    }
    case 'click': case 'download': case 'hover': case 'fill': case 'select': case 'upload': case 'press': {
      if (isBlank(element.name) && !isAllowedUnnamed(step.locator, element, project)) return 'unnamed-control';
      // A download is the click that starts it, so it is guarded exactly as a click.
      if (step.type === 'click' || step.type === 'download') return irreversible(element.name) ? 'irreversible-action' : linkRule(element, policy);
      if (step.type !== 'press' || !ACTIVATING_KEYS.includes(step.key)) return null;
      // Enter or Space presses a focused button or link as a click would, and submits the form
      // around a focused field.
      if (irreversible(element.name)) return 'irreversible-action';
      return linkRule(element, policy) ?? (irreversible(element.formSubmitName) ? 'irreversible-submit' : null);
    }
    case 'frame': case 'expect': case 'expectPage': case 'expectDownload': case 'a11yAudit': case 'capture': case 'remember':
    // Calls act on no page, and stubs, request checks and storage steps on no element: the static
    // check judged them, before the run started.
    case 'call': case 'expectBackend':
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage':
    // A clock advance moves the page's own clock and a clipboard check only reads: neither sends
    // input, so neither is a side effect, and a proposal may hold both.
    case 'advanceClock': case 'expectClipboard':
    // A page script or a database command acts on no element the guard could see: the static check
    // judged its declaration before the run started.
    case 'evaluate': case 'expectScript': case 'database': case 'expectDatabase':
      return null;
  }
}

// ---- The gate -----------------------------------------------------------------------------------

// Added to a denial the audit sink did not record. The denial stands either way; the mark makes
// the lost record show in the outcome instead of passing silently.
const UNRECORDED = { unrecorded: true } as const;

export function policyGate(options: PolicyGateOptions): PolicyGate {
  const { project, events } = options;
  const projectHash = projectFingerprint(project);
  // True when the audit sink accepted the denial's event.
  const record = (rule: PolicyRuleId, plan?: Plan): boolean =>
    events.append({ kind: 'plan.denied', code: rule, ...(plan === undefined ? {} : { subjectHash: planHash(plan) }) }, POLICY_GATE_ACTOR).ok;
  return {
    decide(plan, targets, standing) {
      // A standing made for another plan is no standing: the plan is judged as a proposal.
      const judged = ownStanding(plan, standing);
      const denial = staticDenial(plan, targets, judged, project);
      if (denial === null) return { kind: 'allow', plan: authorised(plan, targets, projectHash, judged.mode) };
      const recorded = record(denial.rule, plan);
      return { kind: 'deny', rule: denial.rule, stepIndex: denial.stepIndex, ...(recorded ? {} : UNRECORDED) };
    },
    guardAction(step, stepIndex, element, dialogText, locale) {
      const patterns = patternsForLocale(locale, project.policy.irreversiblePatterns);
      const rule = patterns === null ? 'no-locale-patterns' : runtimeRule(step, element, dialogText, patterns, project);
      if (rule === null) return { kind: 'allow' };
      const recorded = record(rule);
      return { kind: 'deny', rule, stepIndex, ...(recorded ? {} : UNRECORDED) };
    },
  };
}
