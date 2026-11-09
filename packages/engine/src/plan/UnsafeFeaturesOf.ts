// Which unsafe features a parsed plan uses, and where. The features are plan content, so the plan
// hash covers them; a run's unsafe label, its guarantee statement and its manifest all come from
// unsafeFeaturesOf, never from what a run happened to do, so two runs of one plan say the same.
// Each construct is placed at the field that names its feature, the same path the plan parser
// refuses a disabled one at: a locator's `by`, an assertion's `kind`, a remember source's `read`,
// a step's `type`, and an inline script's `inline`.
import {
  UNSAFE_FEATURES,
  type CommandName, type Plan, type ScriptName, type Step, type StepByType, type StepType, type UnsafeFeature,
} from '@revisum/contracts';
import { isInlineChoice } from './IsInlineChoice.ts';
import { isStepIn, STEP_FACTS, StepSection } from './StepFacts.ts';
import type { UnsafeConstruct } from './UnsafeConstruct.ts';
import { everyPlanStep, visitSteps } from './VisitSteps.ts';

// Each step type's own entry says what of it is unsafe, so a step and the entry reading it can't disagree.
const constructsOfStepOfType = <Type extends StepType>(type: Type, step: StepByType[Type], path: string): readonly UnsafeConstruct[] =>
  STEP_FACTS[type].unsafeConstructs(step, path);

function listConstructs(steps: readonly Step[], path: string): UnsafeConstruct[] {
  const constructs: UnsafeConstruct[] = [];
  visitSteps(steps, (step, place) => {
    constructs.push(...constructsOfStepOfType(step.type, step, place.path));
  }, path);
  return constructs;
}

// Every use of an unsafe feature in the plan, in document order: its steps, frames and second tabs
// included, then its cleanup. Empty for a closed plan.
const unsafeConstructsOf = (plan: Plan): readonly UnsafeConstruct[] =>
  [...listConstructs(plan.steps, '$.steps'), ...listConstructs(plan.cleanup ?? [], '$.cleanup')];

// The unsafe features the plan uses, each once, sorted. Empty for a closed plan. A plan whose only
// script is inline uses inline-page-script, not page-script: each feature is named by what the
// plan holds.
export function unsafeFeaturesOf(plan: Plan): readonly UnsafeFeature[] {
  const used = new Set(unsafeConstructsOf(plan).map((construct) => construct.feature));
  return UNSAFE_FEATURES.filter((feature) => used.has(feature)).sort();
}

// The page scripts and database commands the plan names, each once, so their declarations can be
// recorded in the run's manifest.
export function declarationsNamedBy(plan: Plan): { readonly scripts: readonly ScriptName[]; readonly commands: readonly CommandName[] } {
  const scripts = new Set<ScriptName>();
  const commands = new Set<CommandName>();
  for (const step of everyPlanStep(plan)) {
    if (isStepIn(step, StepSection.PageScripts) && !isInlineChoice(step.script)) {scripts.add(step.script);}
    if (isStepIn(step, StepSection.DatabaseCommands)) {commands.add(step.command);}
  }
  return { scripts: [...scripts], commands: [...commands] };
}
