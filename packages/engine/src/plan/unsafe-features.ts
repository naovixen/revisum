// Which unsafe features a parsed plan uses, and where. The features are plan content, so the plan
// hash covers them; a run's unsafe label, its guarantee statement and its manifest all come from
// unsafeFeaturesOf, never from what a run happened to do, so two runs of one plan say the same.
// Each construct is placed at the field that names its feature, the same path the plan parser
// refuses a disabled one at: a locator's `by`, an assertion's `kind`, a remember source's `read`,
// a step's `type`, and an inline script's `inline`.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import {
  DOM_CHECK_KINDS, UNSAFE_FEATURES,
  type CommandName, type Locator, type Plan, type ScriptName, type Step, type UnsafeFeature,
} from '@revisum/contracts';
import { isOneOf } from './plan-decoders.ts';
import {
  DATABASE_COMMAND_FEATURE, DOM_CHECKS_FEATURE, INLINE_SCRIPT_FEATURE, LOCATOR_FEATURES, NAMED_SCRIPT_FEATURE,
} from './plan-grammar.ts';

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
    case 'frame':
      return [...locatorConstructs(step.locator, `${path}.locator`), ...listConstructs(step.steps, `${path}.steps`)];
    case 'newTab':
      return listConstructs(step.steps, `${path}.steps`);
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
    case 'navigate': case 'dialog': case 'expectPage': case 'expectDownload': case 'a11yAudit': case 'capture':
    case 'call': case 'expectBackend':
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage':
    case 'advanceClock': case 'expectClipboard':
      return [];
  }
}

const listConstructs = (steps: readonly Step[], path: string): UnsafeConstruct[] =>
  steps.flatMap((step, index) => stepConstructs(step, `${path}[${index}]`));

// Every use of an unsafe feature in the plan, in document order: its steps, frames and second tabs
// included, then its cleanup. Empty for a closed plan.
export const unsafeConstructsOf = (plan: Plan): readonly UnsafeConstruct[] =>
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
  const visit = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if (step.type === 'frame' || step.type === 'newTab') visit(step.steps);
      if ((step.type === 'evaluate' || step.type === 'expectScript') && typeof step.script === 'string') scripts.add(step.script);
      if (step.type === 'database' || step.type === 'expectDatabase') commands.add(step.command);
    }
  };
  visit(plan.steps);
  visit(plan.cleanup ?? []);
  return { scripts: [...scripts], commands: [...commands] };
}
