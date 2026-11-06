// Which unsafe features a parsed plan uses, and where. The features are plan content, so the plan
// hash covers them; a run's unsafe label, its guarantee statement and its manifest all come from
// unsafeFeaturesOf, never from what a run happened to do, so two runs of one plan say the same.
// Each construct is placed at the field that names its feature, the same path the plan parser
// refuses a disabled one at: a locator's `by`, an assertion's `kind`, a remember source's `read`,
// a step's `type`, and an inline script's `inline`.
import {
  DOM_CHECK_KINDS, UNSAFE_FEATURES,
  type CommandName, type Locator, type Plan, type ScriptName, type Step, type UnsafeFeature,
} from '@revisum/contracts';
import { isOneOf } from './plan-decoders.ts';
import {
  DATABASE_COMMAND_FEATURE, DOM_CHECKS_FEATURE, INLINE_SCRIPT_FEATURE, LOCATOR_FEATURES, NAMED_SCRIPT_FEATURE,
} from './plan-grammar.ts';
import { isStepIn, StepSection } from './StepFacts.ts';
import { everyPlanStep, visitSteps } from './VisitSteps.ts';

// One use of an unsafe feature, at the JSON path of the field that names it.
export type UnsafeConstruct = { readonly feature: UnsafeFeature; readonly path: string };

// A locator's own feature, then those of the locators it is evaluated inside.
function locatorConstructs(locator: Locator, path: string): UnsafeConstruct[] {
  if (locator.by !== 'css' && locator.by !== 'xpath') return [];
  const own = { feature: LOCATOR_FEATURES[locator.by], path: `${path}.by` };
  return locator.inside === undefined ? [own] : [own, ...locatorConstructs(locator.inside, `${path}.inside`)];
}

function stepConstructs(step: Step, path: string): UnsafeConstruct[] {
  switch (step.type) {
    case 'click': case 'download': case 'hover': case 'fill': case 'select': case 'upload': case 'press':
      return locatorConstructs(step.locator, `${path}.locator`);
    // The steps inside a frame or a second tab are visited on their own.
    case 'frame':
      return locatorConstructs(step.locator, `${path}.locator`);
    case 'expect': {
      const check = isOneOf(DOM_CHECK_KINDS, step.assert.kind) ? [{ feature: DOM_CHECKS_FEATURE, path: `${path}.assert.kind` }] : [];
      return [...locatorConstructs(step.locator, `${path}.locator`), ...check];
    }
    case 'remember': {
      if (!('element' in step.from)) return [];
      const read = step.from.read === 'attribute' ? [{ feature: DOM_CHECKS_FEATURE, path: `${path}.from.read` }] : [];
      return [...read, ...locatorConstructs(step.from.element, `${path}.from.element`)];
    }
    case 'evaluate': case 'expectScript':
      return [typeof step.script === 'string'
        ? { feature: NAMED_SCRIPT_FEATURE, path: `${path}.type` }
        : { feature: INLINE_SCRIPT_FEATURE, path: `${path}.script.inline` }];
    case 'database': case 'expectDatabase':
      return [{ feature: DATABASE_COMMAND_FEATURE, path: `${path}.type` }];
    case 'navigate': case 'newTab': case 'dialog': case 'expectPage': case 'expectDownload': case 'a11yAudit': case 'capture':
    case 'call': case 'expectBackend':
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage':
    case 'advanceClock': case 'expectClipboard':
      return [];
  }
}

function listConstructs(steps: readonly Step[], path: string): UnsafeConstruct[] {
  const constructs: UnsafeConstruct[] = [];
  visitSteps(steps, (step, place) => {
    constructs.push(...stepConstructs(step, place.path));
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
    if (isStepIn(step, StepSection.PageScripts) && typeof step.script === 'string') scripts.add(step.script);
    if (isStepIn(step, StepSection.DatabaseCommands)) commands.add(step.command);
  }
  return { scripts: [...scripts], commands: [...commands] };
}
