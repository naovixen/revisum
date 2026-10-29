// Opening plan language 1.3 dates the 1.2 entry of the changelog, since every 1.2 parser part has
// landed, and adds one "1.3" entry naming each new locator, check, step, project setting and error
// code, in code type, with the schema's sha256. That the newest entry names the committed schema's
// hash is checked in plan-schema-check.test.ts.
// See docs/specs/SPEC-36-unsafe-plan-features.md (Build notes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changelogEntry, entriesFor } from '../support/plan-changelog.ts';

const NAMED_IN_ENTRY = [
  // Locators.
  'css', 'xpath', 'selector', 'expression', 'hasText', 'inside',
  // DOM checks and remembering an attribute.
  'hasClass', 'lacksClass', 'computedStyleEquals', 'attributeEquals', 'attributeAbsent', 'attribute',
  // Steps.
  'evaluate', 'expectScript', 'inline', 'database', 'expectDatabase',
  // Project settings.
  'unsafeFeatures', 'cssLocators', 'xpathLocators', 'domChecks', 'pageScripts', 'allowInline', 'databaseCommands',
  'unnamedControlsAllowed', 'scriptCheckTimeoutMilliseconds', 'port',
  // The six feature names.
  'css-locator', 'xpath-locator', 'dom-checks', 'page-script', 'inline-page-script', 'database-command',
  // Error codes.
  'unsafe_feature_disabled', 'inline-script-in-proposal', 'no-readable-form',
];

test('the 1.2 changelog entry is dated once 1.3 is open', { criterion: 'AC-SPEC-36-02' }, () => {
  assert.match(changelogEntry('1.2'), /^## 1\.2 \(\d{4}-\d{2}-\d{2}/);
});

test('the changelog has one 1.3 entry, unreleased or dated, with a schema sha256', { criterion: 'AC-SPEC-36-02' }, () => {
  const entry = changelogEntry('1.3');
  assert.match(entry, /^## 1\.3 \((unreleased|\d{4}-\d{2}-\d{2})/);
  assert.match(entry, /Schema sha256: `[0-9a-f]{64}`/);
  assert.equal(entriesFor('1.3').length, 1);
});

test('the 1.3 changelog entry names each new locator, check, step, setting, feature and error code, in code type', { criterion: 'AC-SPEC-36-02' }, () => {
  const entry = changelogEntry('1.3');
  assert.match(entry, /^## 1\.3\b/);
  assert.deepEqual(NAMED_IN_ENTRY.filter((name) => !entry.includes(`\`${name}\``)), [], 'names the 1.3 entry leaves out');
});
