// A plan 1.3 plan's hash, and so its approval, does not depend on the form or layout it was written
// in: each unsafe golden plan and coverage plan has the same hash read from its JSON, its canonical
// text and its text laid out differently. Any change to an unsafe step's text changes the hash: a
// selector, a script line, a carriage return in a source, a returned field or a database argument.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planHash, writePlanJson, writePlanText } from '@revisum/engine';
import { joinLines, lineOf, linesOf, withLineReplaced } from './readable-plan-examples.ts';
import { everyUnsafeExample, parseAll, parsedWith, planFromText, unsafeGoldenPlan, unsafeGoldenText, type FeatureName } from './unsafe-readable-examples.ts';

const MARKED = /^(\s*)Unsafe:( .*)$/;

const LAYOUTS: readonly { readonly name: string; readonly relayout: (text: string) => string }[] = [
  { name: 'its canonical text', relayout: (text) => text },
  { name: 'its text with the mark in lower case', relayout: (text) => joinLines(linesOf(text).map((line) => line.replace(MARKED, '$1unsafe:$2'))) },
  { name: 'its text with blank and comment lines between every line', relayout: (text) => joinLines(linesOf(text).flatMap((line) => [line, '', '# note'])) },
  { name: 'its text with CRLF line ends', relayout: (text) => text.replaceAll('\n', '\r\n') },
];

for (const { name, plan } of everyUnsafeExample()) {
  const fromJson = (): string => planHash(parsedWith(parseAll, plan, name));
  for (const { name: layoutName, relayout } of LAYOUTS) {
    test(`${name} read from ${layoutName} has the hash of the plan read from JSON`, { criterion: 'AC-SPEC-28-07' }, () => {
      const text = writePlanText(parsedWith(parseAll, plan, name));
      assert.equal(planHash(planFromText(relayout(text), `${name} from ${layoutName}`)), fromJson());
    });
  }

  test(`${name} read from its canonical JSON has the hash of the plan read from its JSON as written`, { criterion: 'AC-SPEC-28-07' }, () => {
    const canonical = writePlanJson(parsedWith(parseAll, plan, name));
    assert.equal(planHash(parsedWith(parseAll, JSON.parse(canonical), `${name} from canonical JSON`)), fromJson());
  });
}

// Changes to one line of a golden text, each of which makes it a different plan.
const STEP_CHANGES: readonly { readonly feature: FeatureName; readonly name: string; readonly from: string; readonly to: string }[] = [
  { feature: 'css-locator', name: 'a selector', from: 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"', to: 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.products"' },
  { feature: 'css-locator', name: 'a locator\'s containing text', from: 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"', to: 'Unsafe: Click css "button" containing text "Add!" inside 2nd css "li.product"' },
  { feature: 'css-locator', name: 'the position of an inner locator', from: 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"', to: 'Unsafe: Click css "button" containing text "Add" inside 3rd css "li.product"' },
  { feature: 'xpath-locator', name: 'an expression', from: 'Unsafe: Expect xpath "//main//li[2]" has text containing "Total"', to: 'Unsafe: Expect xpath "//main//li[3]" has text containing "Total"' },
  { feature: 'dom-checks', name: 'an attribute check\'s kind', from: 'Unsafe: Expect button "Check out" attribute disabled is absent', to: 'Unsafe: Expect button "Check out" attribute disabled is "absent"' },
  { feature: 'page-script', name: 'a script argument', from: 'Unsafe: Run page script readCart with currency "eur" remembering field itemCount as cartCount', to: 'Unsafe: Run page script readCart with currency "usd" remembering field itemCount as cartCount' },
  { feature: 'inline-page-script', name: 'a script line', from: '"() => ({ blocks: window.editorStore.blocks.length })"', to: '"() => ({ blocks: window.editorStore.blocks.length  })"' },
  { feature: 'inline-page-script', name: 'a carriage return at the end of a source', from: '"() => ({ blocks: window.editorStore.blocks.length })"', to: '"() => ({ blocks: window.editorStore.blocks.length })\\r"' },
  { feature: 'inline-page-script', name: 'a returned field\'s pointer', from: 'Unsafe: Run inline read page script returning blockCount at "/blocks" remembering field blockCount as blockCount:', to: 'Unsafe: Run inline read page script returning blockCount at "/count" remembering field blockCount as blockCount:' },
  { feature: 'database-command', name: 'a database argument', from: 'Unsafe: Expect database command countOrders with email "ada@example.com" field count is "3"', to: 'Unsafe: Expect database command countOrders with email "grace@example.com" field count is "3"' },
];

for (const { feature, name, from, to } of STEP_CHANGES) {
  test(`changing ${name} in the ${feature} golden text changes the hash`, { criterion: 'AC-SPEC-28-07' }, () => {
    const original = unsafeGoldenText(feature);
    const line = lineOf(original, from);
    const indent = /^\s*/.exec(linesOf(original)[line - 1] ?? '')?.[0] ?? '';
    const changed = planFromText(withLineReplaced(original, line, `${indent}${to}`), `${feature} with ${name} changed`);
    assert.notEqual(planHash(changed), planHash(parsedWith(parseAll, unsafeGoldenPlan(feature), feature)));
  });
}

test('a script line added at the end of a source, even an empty one, changes the hash', { criterion: 'AC-SPEC-28-07' }, () => {
  const original = unsafeGoldenText('inline-page-script');
  const line = lineOf(original, '"() => ({ blocks: window.editorStore.blocks.length })"');
  const lines = linesOf(original);
  const withEmptyLine = joinLines([...lines.slice(0, line), '  ""', ...lines.slice(line)]);
  assert.notEqual(planHash(planFromText(withEmptyLine, 'a final empty script line')), planHash(parsedWith(parseAll, unsafeGoldenPlan('inline-page-script'), 'inline')));
});
