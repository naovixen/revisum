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
//     decision carries a ClearedRun, the only kind run() accepts, and only for a target both the
//     plan and this project's matrix declare: it holds the plan with this project, that matrix entry
//     and the standing it was judged as, so none can be swapped. Any other target id gets a
//     TargetNotDeclared, on which nothing runs.
//   - guardAction() is the runtime guard. The driver calls it just before every action, with the
//     element the locator resolved to and any open dialog's text, so it sees what the plan alone
//     cannot: the name behind a test id, the form a key press would submit, where a link leads.
//
// Both are deterministic and read nothing but their arguments and the project. Each denial appends
// one plan.denied audit event whose code is the rule, so a denial leaves a record even when
// nothing ran; a denial the audit sink failed to record is marked unrecorded.
import { AuditEventKind, PolicyRuleId, PolicyVerdictKind } from '@revisum/contracts';
import type {
  Authorised, EventSink, GuardVerdict, Locale, Plan, PlanDenial, ResolvedElement, SecretName, Step, Target, TargetId,
} from '@revisum/contracts';
import { deriveActor, sourceActorId } from '../approval/DeriveActor.ts';
import { ownStanding, type PlanStanding } from '../approval/PlanStanding.ts';
import { PlanStandingMode } from '../approval/PlanStandingMode.ts';
import { planHash } from '../run/seal/BuildManifest.ts';
import { unsafeFeaturesOf } from '../plan/UnsafeFeaturesOf.ts';
import type { Limits, Project } from '../project/ParseProject.ts';
import { enabledUnsafeFeatures } from '../project/ReadUnsafeFeatures.ts';
import { ClearedRun, ClearedRunKind } from './ClearedRun.ts';
import { isProductionAllowed } from './IsProductionAllowed.ts';
import { targetNotDeclared, type TargetNotDeclared } from './TargetNotDeclared.ts';
import { everyIrreversiblePattern, patternsForLocale } from './BuiltInIrreversiblePatterns.ts';
import { callRuleBeforeRun, ruleBeforeRun, ruleDuringRun, type StaticContext } from './StepRules.ts';
import { everyPlanStep, visitSteps } from '../plan/VisitSteps.ts';
import { frameDepthInside, holdsSteps, isDeeperThanAllowed, isStepIn, StepSection } from '../plan/StepFacts.ts';
import { secretsNamedBy } from '../plan/SecretsNamedBy.ts';

// What the gate gives a plan it allows for one target id: a cleared run when both the plan and the
// project's matrix declare the target, and otherwise a TargetNotDeclared, on which nothing may run.
export type TargetClearance = ClearedRun | TargetNotDeclared;
// What the gate decided about a plan for the targets it will run on: on an allow, one clearance per
// target id, in the order given, so a target that is not declared still has an outcome of its own.
export type PlanClearance = { readonly kind: typeof PolicyVerdictKind.Allow; readonly runs: readonly TargetClearance[] } | PlanDenial;
// The same, for one target.
export type RunClearance = { readonly kind: typeof PolicyVerdictKind.Allow; readonly run: ClearedRun } | TargetNotDeclared | PlanDenial;

export interface PolicyGate {
  // The static check of a whole plan for the targets it will run on. A missing standing, or one
  // whose approval is for another plan's hash, is a proposal.
  // Each target is judged as the project's matrix declares it, by its id. A denial is for the whole
  // plan, whichever targets are declared.
  decide(plan: Plan, targetIds: readonly TargetId[], standing?: PlanStanding): PlanClearance;
  // decide() for a plan that runs on one target.
  clear(plan: Plan, targetId: TargetId, standing?: PlanStanding): RunClearance;
  // The runtime check of one action. A step that acts on no element, such as a dialog step,
  // passes an element with every field null.
  guardAction(step: Step, stepIndex: number, element: ResolvedElement, dialogText: string | null, locale: Locale): GuardVerdict;
}

export type PolicyGateOptions = {
  // The person-written project whose origins, limits and policy the gate applies.
  readonly project: Project;
  readonly events: EventSink;
};

type Denial = { readonly rule: PolicyRuleId; readonly stepIndex: number | null };

// The gate does not know who wrote the plan it denies, so its events carry no person.
const POLICY_GATE_ACTOR = deriveActor(sourceActorId('policy gate'), 'unverified');

// A plan is Authorised only here, as decide() clears it into its runs.
const authorised = (plan: Plan): Authorised => plan as Authorised;

// The steps a plan holds, including those inside frames and second tabs, each with the index of
// its top-level step. A second tab's steps are judged exactly as the first tab's would be.
function everyStep(steps: readonly Step[]): { readonly step: Step; readonly index: number }[] {
  const found: { readonly step: Step; readonly index: number }[] = [];
  visitSteps(steps, (step, place) => {
    found.push({ step, index: place.topIndex });
  });
  return found;
}

// ---- The static check ---------------------------------------------------------------------------

// The same limits the plan parser applies, checked again against the trusted project, so a plan
// parsed under looser settings is still held to the trusted ones.
function isOverLimit(plan: Plan, limits: Limits): boolean {
  const listTooLong = (steps: readonly Step[], depth: number): boolean =>
    steps.length > limits.maximumSteps
    || steps.some((step) => holdsSteps(step) && innerTooDeepOrLong(step.steps, frameDepthInside(step.type, depth)));
  const innerTooDeepOrLong = (steps: readonly Step[], depth: number): boolean =>
    isDeeperThanAllowed(depth, limits.maximumFrameDepth) || listTooLong(steps, depth);
  const bytes = new TextEncoder().encode(JSON.stringify(plan)).length;
  const scripts = everyStep(plan.steps).filter(({ step }) => isStepIn(step, StepSection.PageScripts));
  const calls = callingSteps(plan).filter(({ step }) => isStepIn(step, StepSection.ServiceCalls, StepSection.DatabaseCommands));
  return bytes > limits.maximumPlanBytes || listTooLong(plan.steps, 0) || calls.length + scripts.length > limits.maximumCalls;
}

// The steps that may call a service or run a database command, the plan's steps first and its
// cleanup after, each with its step index, or null for a cleanup step, which no step index names.
// Both stand only at the top level, so frames and second tabs hold none. A check counts once,
// however often it polls.
const callingSteps = (plan: Plan): { readonly step: Step; readonly index: number | null }[] => [
  ...plan.steps.map((step, index) => ({ step, index })),
  ...(plan.cleanup ?? []).map((step) => ({ step, index: null })),
];

// The secrets the plan itself names, frames, second tabs and cleanup included.
function secretNamesOf(plan: Plan): readonly SecretName[] {
  const named = everyPlanStep(plan).flatMap(secretsNamedBy);
  return plan.storageState === undefined ? named : [...named, plan.storageState.secretName];
}

// The parser judged these against the project it was given, which may not be the one clearing the
// plan. Plan-wide, before any step, so no standing can skip them.
function undeclaredUseRule(plan: Plan, project: Project): PolicyRuleId | null {
  const enabled = enabledUnsafeFeatures(project.unsafeFeatures);
  if (unsafeFeaturesOf(plan).some((feature) => !enabled.includes(feature))) {
    return 'unsafe-feature-disabled';
  }
  return secretNamesOf(plan).some((name) => !project.secretNames.includes(name)) ? 'undeclared-secret' : null;
}

function staticDenial(plan: Plan, targets: readonly Target[], standing: PlanStanding, project: Project): Denial | null {
  if (isOverLimit(plan, project.limits)) {return { rule: PolicyRuleId.OverLimit, stepIndex: null };}
  const undeclaredUse = undeclaredUseRule(plan, project);
  if (undeclaredUse !== null) {
    return { rule: undeclaredUse, stepIndex: null };
  }
  const patternSets = targets.map((target) => patternsForLocale(target.locale, project.policy.irreversiblePatterns));
  // With no targets no language is known, so every pattern applies: the engine's own never lapse.
  const patterns: string[] = targets.length === 0 ? [...everyIrreversiblePattern(project.policy.irreversiblePatterns)] : [];
  for (const set of patternSets) {
    if (set === null) {return { rule: PolicyRuleId.NoLocalePatterns, stepIndex: null };}
    patterns.push(...set);
  }
  // The standing is already the plan's own (ownStanding), never another plan's.
  const productionAllowed = isProductionAllowed(standing, project.policy);
  const context: StaticContext = { project, patterns, productionAllowed, approved: standing.mode === PlanStandingMode.Approved };
  for (const { step, index } of everyStep(plan.steps)) {
    const rule = ruleBeforeRun(step, context);
    if (rule !== null) {return { rule, stepIndex: index };}
  }
  for (const { step, index } of callingSteps(plan)) {
    const rule = callRuleBeforeRun(step, context);
    if (rule !== null) {return { rule, stepIndex: index };}
  }
  return null;
}

// ---- The gate -----------------------------------------------------------------------------------

// Added to a denial the audit sink did not record. The denial stands either way; the mark makes
// the lost record show in the outcome instead of passing silently.
const UNRECORDED = { unrecorded: true } as const;

// A plan the static check found nothing to deny in, with the standing it was judged as.
type Judged = { readonly kind: typeof PolicyVerdictKind.Allow; readonly plan: Authorised; readonly standing: PlanStanding };

export function policyGate(options: PolicyGateOptions): PolicyGate {
  const { project, events } = options;
  // True when the audit sink accepted the denial's event.
  const record = (rule: PolicyRuleId, plan?: Plan): boolean =>
    events.append({ kind: AuditEventKind.PlanDenied, code: rule, ...(plan === undefined ? {} : { subjectHash: planHash(plan) }) }, POLICY_GATE_ACTOR).ok;
  // The plan as cleared with the standing it was judged as, or the gate's denial, recorded.
  const judge = (plan: Plan, targetIds: readonly TargetId[], standing: PlanStanding | undefined): Judged | PlanDenial => {
    // Only the targets the plan declares: one it does not gets no run, so its locale must not decide
    // the plan's patterns either, and the gate answers it not-declared rather than denying the plan.
    const declared = targetIds.filter((id) => plan.targets.includes(id));
    const targets = declared.flatMap((id) => project.matrix.filter((target) => target.id === id));
    // A standing made for another plan is no standing: the plan is judged as a proposal.
    const judged = ownStanding(plan, standing);
    const denial = staticDenial(plan, targets, judged, project);
    if (denial === null) {return { kind: PolicyVerdictKind.Allow, plan: authorised(plan), standing: judged };}
    const recorded = record(denial.rule, plan);
    return { kind: PolicyVerdictKind.Deny, rule: denial.rule, stepIndex: denial.stepIndex, ...(recorded ? {} : UNRECORDED) };
  };
  const clearanceFor = (judged: Judged, targetId: TargetId): TargetClearance => {
    const target = judged.plan.targets.includes(targetId) ? project.matrix.find((candidate) => candidate.id === targetId) : undefined;
    return target === undefined
      ? targetNotDeclared({ plan: judged.plan, project, targetId, standing: judged.standing })
      : new ClearedRun({ plan: judged.plan, project, target, standing: judged.standing });
  };
  return {
    decide(plan, targetIds, standing) {
      const judged = judge(plan, targetIds, standing);
      return judged.kind === PolicyVerdictKind.Deny ? judged : { kind: PolicyVerdictKind.Allow, runs: targetIds.map((targetId) => clearanceFor(judged, targetId)) };
    },
    clear(plan, targetId, standing) {
      const judged = judge(plan, [targetId], standing);
      if (judged.kind === PolicyVerdictKind.Deny) {
        return judged;
      }
      const clearance = clearanceFor(judged, targetId);
      return clearance.kind === ClearedRunKind ? { kind: PolicyVerdictKind.Allow, run: clearance } : clearance;
    },
    guardAction(step, stepIndex, element, dialogText, locale) {
      const patterns = patternsForLocale(locale, project.policy.irreversiblePatterns);
      const rule = patterns === null ? 'no-locale-patterns' : ruleDuringRun(step, { element, dialogText, patterns, project });
      if (rule === null) {return { kind: PolicyVerdictKind.Allow };}
      const recorded = record(rule);
      return { kind: PolicyVerdictKind.Deny, rule, stepIndex, ...(recorded ? {} : UNRECORDED) };
    },
  };
}
