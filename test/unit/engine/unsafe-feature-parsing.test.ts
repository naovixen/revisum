// The one plan parser reads which unsafe features the trusted project enables. A 1.3 plan that uses
// a feature its project leaves off is refused with unsafe_feature_disabled at every path where the
// feature appears, echoing nothing from the plan, and nothing runs. Inline scripts need both page
// scripts and inline scripts enabled. A CSS selector or XPath expression is literal, single-line
// plan text of at most 512 characters with no "{", "}", ";" or "@", and an `inside` chain is at
// most 3 deep, so what a locator can match is fixed when the plan is approved.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, runUntrusted } from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { PRIVATE_MARKER, defaultParser } from './plan-examples.ts';
import { spyDriver } from './secret-examples.ts';
import { fakeServiceCaller } from './service-call-examples.ts';
import {
  acceptedBy, allBut, disabledPaths, errorsOf, parsedProject, parserEnabling, rejection,
} from './unsafe-feature-examples.ts';
import {
  ALL_FEATURES_PATHS, ALL_FEATURES_PLAN, CSS_CHECK, FEATURES, FEATURE_EXAMPLES, INLINE_READ, OPEN_CART, ORIGIN, XPATH_CHECK,
  css, unsafePlan, unsafeProjectFile, xpath, type FeatureName, type JsonRecord,
} from './unsafe-feature-steps.ts';

const NOTHING_ENABLED: readonly FeatureName[] = [];

// ---- One plan per feature, with that feature off ---------------------------------------------------

for (const example of FEATURE_EXAMPLES) {
  test(`a 1.3 plan using ${example.feature} is refused with unsafe_feature_disabled at ${example.path} when every other feature is on`, { criterion: 'AC-SPEC-36-01' }, () => {
    const errors = errorsOf(parserEnabling(allBut(example.feature)), unsafePlan(example.steps));
    assert.deepEqual(disabledPaths(errors), [example.path]);
  });

  test(`a 1.3 plan using ${example.feature} is refused the same way when no feature is on`, { criterion: 'AC-SPEC-36-01' }, () => {
    const errors = errorsOf(parserEnabling(NOTHING_ENABLED), unsafePlan(example.steps));
    assert.deepEqual(disabledPaths(errors), [example.path]);
  });

  // Counter-example: the plan itself is valid, so the refusal above comes from the project alone.
  test(`the same plan using ${example.feature} parses once the project enables it`, { criterion: 'AC-SPEC-36-01' }, () => {
    acceptedBy(parserEnabling(FEATURES), unsafePlan(example.steps));
  });
}

test('an inline script is refused at .script.inline when page scripts are on but inline scripts are off', { criterion: 'AC-SPEC-36-01' }, () => {
  const errors = errorsOf(parserEnabling(allBut('inline-page-script')), unsafePlan([OPEN_CART, INLINE_READ]));
  assert.deepEqual(disabledPaths(errors), ['$.steps[1].script.inline']);
  assert.ok(errors.every((error) => error.code === 'unsafe_feature_disabled'), JSON.stringify(errors));
});

test('an inline script is refused at .script.inline, and only there, when page scripts are off too', { criterion: 'AC-SPEC-36-01' }, () => {
  const errors = errorsOf(parserEnabling(allBut('page-script')), unsafePlan([OPEN_CART, INLINE_READ]));
  assert.deepEqual(disabledPaths(errors), ['$.steps[1].script.inline']);
});

// ---- Every use, in one plan ----------------------------------------------------------------------

test('a plan using all six features under a project enabling none is refused at every use, nested and in cleanup included', { criterion: 'AC-SPEC-36-01' }, () => {
  const errors = errorsOf(parserEnabling(NOTHING_ENABLED), ALL_FEATURES_PLAN());
  assert.deepEqual(disabledPaths(errors), [...ALL_FEATURES_PATHS].sort());
});

test('the same plan under a project with no unsafeFeatures section at all is refused at the same paths', { criterion: 'AC-SPEC-36-01' }, () => {
  // The shared test project as it was before plan 1.3.
  const errors = errorsOf(defaultParser(), ALL_FEATURES_PLAN());
  assert.deepEqual(disabledPaths(errors), [...ALL_FEATURES_PATHS].sort());
});

test('two uses of one disabled feature are both reported, not only the first', { criterion: 'AC-SPEC-36-01' }, () => {
  const plan = unsafePlan([OPEN_CART, CSS_CHECK, { type: 'click', locator: css('button.add-to-cart') }, CSS_CHECK]);
  assert.deepEqual(disabledPaths(errorsOf(parserEnabling(allBut('css-locator')), plan)), ['$.steps[1].locator.by', '$.steps[2].locator.by', '$.steps[3].locator.by']);
});

test('only the disabled feature is reported when the plan also uses enabled ones', { criterion: 'AC-SPEC-36-01' }, () => {
  const plan = unsafePlan([OPEN_CART, CSS_CHECK, XPATH_CHECK]);
  assert.deepEqual(disabledPaths(errorsOf(parserEnabling(['css-locator']), plan)), ['$.steps[2].locator.by']);
});

test('the plan using all six parses once the project enables all six', { criterion: 'AC-SPEC-36-01' }, () => {
  acceptedBy(parserEnabling(FEATURES), ALL_FEATURES_PLAN());
});

// ---- Nothing is echoed ------------------------------------------------------------------------------

test('a refusal for a disabled feature echoes no selector, expression, script text or argument', { criterion: 'AC-SPEC-36-01' }, () => {
  const plan = unsafePlan([
    OPEN_CART,
    { type: 'click', locator: css(`button.${PRIVATE_MARKER}`) },
    { type: 'click', locator: xpath(`//button[contains(text(),"${PRIVATE_MARKER}")]`) },
    { type: 'evaluate', script: { inline: { source: `() => "${PRIVATE_MARKER}"`, effect: 'read' } }, arguments: {} },
    { type: 'evaluate', script: 'seedEditor', arguments: { text: PRIVATE_MARKER } },
  ]);
  const errors = errorsOf(parserEnabling(NOTHING_ENABLED), plan);
  assert.ok(errors.length >= 4, JSON.stringify(errors));
  assert.ok(!JSON.stringify(errors).includes(PRIVATE_MARKER), 'a refusal echoed the plan\'s text');
});

// ---- Nothing runs ----------------------------------------------------------------------------------

test('a plan refused for a disabled feature opens no browser, makes no call and runs no script or command', { criterion: 'AC-SPEC-36-01' }, async () => {
  const project = parsedProject(unsafeProjectFile(NOTHING_ENABLED));
  const parse = parserEnabling(NOTHING_ENABLED);
  const spy = spyDriver();
  const { caller, requests } = fakeServiceCaller();
  const ports = {
    drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(),
    events: memoryRunEventSink(), services: caller,
  };
  const base = { project, baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  const plans: readonly JsonRecord[] = [...FEATURE_EXAMPLES.map((example) => unsafePlan(example.steps)), ALL_FEATURES_PLAN()];
  for (const plan of plans) {
    const outcome = await runUntrusted(plan, parse, base, ports);
    assert.ok('state' in outcome && outcome.state === 'Rejected', JSON.stringify(outcome));
    if ('errors' in outcome) assert.ok(outcome.errors.some((error) => error.code === 'unsafe_feature_disabled'), JSON.stringify(outcome.errors));
  }
  assert.equal(spy.opens, 0, 'a browser was opened, so a script could have run in it');
  assert.equal(requests.length, 0, 'a call was made');
});

// ---- Selector and expression text -------------------------------------------------------------------

type LocatorCase = { readonly kind: 'css' | 'xpath'; readonly field: 'selector' | 'expression'; readonly locator: (text: unknown, fields?: JsonRecord) => JsonRecord };
const LOCATOR_KINDS: readonly LocatorCase[] = [
  { kind: 'css', field: 'selector', locator: css },
  { kind: 'xpath', field: 'expression', locator: xpath },
];

// A plan that clicks the locator, with a value orderCode defined, so a reference to it is defined.
const clickPlan = (locator: JsonRecord): JsonRecord =>
  unsafePlan([OPEN_CART, { type: 'click', locator }], { values: { orderCode: { kind: 'uniqueText', prefix: 'order' } } });

const parseAll = parserEnabling(FEATURES);
const BASE_TEXT: Readonly<Record<LocatorCase['kind'], string>> = { css: 'ul.cart > li.item', xpath: '//ul//li[2]' };

for (const locatorCase of LOCATOR_KINDS) {
  const path = `$.steps[1].locator.${locatorCase.field}`;

  test(`a ${locatorCase.kind} locator whose ${locatorCase.field} is a value reference is refused with wrong_type`, { criterion: 'AC-SPEC-36-05' }, () => {
    assert.deepEqual(rejection(parseAll, clickPlan(locatorCase.locator({ valueName: 'orderCode' }))), [`wrong_type ${path}`]);
  });

  test(`a ${locatorCase.kind} ${locatorCase.field} holding a line break is refused with unsafe_text`, { criterion: 'AC-SPEC-36-05' }, () => {
    for (const lineBreak of ['\n', '\r\n', '\r']) {
      assert.deepEqual(rejection(parseAll, clickPlan(locatorCase.locator(`${BASE_TEXT[locatorCase.kind]}${lineBreak}li`))), [`unsafe_text ${path}`], JSON.stringify(lineBreak));
    }
  });

  for (const character of ['{', '}', ';', '@']) {
    test(`a ${locatorCase.kind} ${locatorCase.field} holding "${character}" is refused with unsafe_text, echoing nothing`, { criterion: 'AC-SPEC-36-05' }, () => {
      const errors = errorsOf(parseAll, clickPlan(locatorCase.locator(`${BASE_TEXT[locatorCase.kind]}${character}${PRIVATE_MARKER}`)));
      assert.deepEqual(errors.map((error) => `${error.code} ${error.path}`), [`unsafe_text ${path}`]);
      assert.ok(!JSON.stringify(errors).includes(PRIVATE_MARKER), 'the refusal echoed the text');
    });
  }

  test(`a ${locatorCase.kind} ${locatorCase.field} of 513 characters is refused with too_long, and one of 512 parses`, { criterion: 'AC-SPEC-36-05' }, () => {
    const padded = (length: number): string => `${BASE_TEXT[locatorCase.kind]}${'a'.repeat(length - BASE_TEXT[locatorCase.kind].length)}`;
    assert.equal(padded(513).length, 513);
    assert.deepEqual(rejection(parseAll, clickPlan(locatorCase.locator(padded(513)))), [`too_long ${path}`]);
    acceptedBy(parseAll, clickPlan(locatorCase.locator(padded(512))));
  });

  // Counter-example: the same locator with safe literal text parses, so the refusals above come
  // from the text alone.
  test(`a ${locatorCase.kind} locator with safe literal text parses`, { criterion: 'AC-SPEC-36-05' }, () => {
    acceptedBy(parseAll, clickPlan(locatorCase.locator(BASE_TEXT[locatorCase.kind])));
  });

  test(`a ${locatorCase.kind} locator's hasText may hold a value reference, though its ${locatorCase.field} may not`, { criterion: 'AC-SPEC-36-05' }, () => {
    acceptedBy(parseAll, clickPlan(locatorCase.locator(BASE_TEXT[locatorCase.kind], { hasText: { valueName: 'orderCode' } })));
  });
}

test('an XPath expression selecting by attribute is refused, since it needs "@"', { criterion: 'AC-SPEC-36-05' }, () => {
  assert.deepEqual(rejection(parseAll, clickPlan(xpath('//button[@type="submit"]'))), ['unsafe_text $.steps[1].locator.expression']);
});

test('a selector error inside an inside locator is reported at its own path', { criterion: 'AC-SPEC-36-05' }, () => {
  const plan = clickPlan(css('button.add', { inside: css('li.product;') }));
  assert.deepEqual(rejection(parseAll, plan), ['unsafe_text $.steps[1].locator.inside.selector']);
});

// ---- The inside chain ------------------------------------------------------------------------------

// A CSS locator nested `depth` times through `inside`, alternating CSS and XPath and ending in a
// role locator, so every kind of locator may stand inside.
function nested(depth: number): JsonRecord {
  let locator: JsonRecord = { by: 'role', role: 'region', name: 'Products' };
  for (let level = depth; level >= 1; level--) {
    locator = level % 2 === 0 ? xpath('//li', { inside: locator }) : css('li.product', { inside: locator });
  }
  return css('button.add', { inside: locator });
}

test('an inside chain 3 deep parses', { criterion: 'AC-SPEC-36-05' }, () => {
  acceptedBy(parseAll, clickPlan(nested(2)));
});

test('an inside chain 4 deep is refused with too_large at the inside that goes past the limit', { criterion: 'AC-SPEC-36-05' }, () => {
  // nested(3) puts four locators under the clicked one: the fourth `inside` is one too many.
  assert.deepEqual(rejection(parseAll, clickPlan(nested(3))), ['too_large $.steps[1].locator.inside.inside.inside.inside']);
});

test('an inside chain far past the limit gets the same one error, at the same place', { criterion: 'AC-SPEC-36-05' }, () => {
  assert.deepEqual(rejection(parseAll, clickPlan(nested(40))), ['too_large $.steps[1].locator.inside.inside.inside.inside']);
});
