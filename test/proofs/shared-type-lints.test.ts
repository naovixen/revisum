// The lint guards around the shared types. Each test plants one file in a throw-away copy of the
// repository and runs the repository's lint commands over it:
//   - a DerivedActor built outside the approval verifier or core's runtime fails the lint;
//   - a cast to a branded type outside its owning module fails the lint;
//   - a gate that compares an actor type with 'person-verified' alone fails the lint.
// Each rule also has a counter-example that must pass, so the lint is shown to fail for the
// planted reason rather than for everything.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyRepository, type LintOutcome, type ScratchRepository } from './scratch-repository.ts';

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const TIMEOUT = 300_000;

function assertLintFailsOn(relativePath: string, source: string): void {
  const outcome: LintOutcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

function assertLintPassesWith(relativePath: string, source: string): void {
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, true, `the lint rejected ${relativePath}:\n${outcome.failureOutput}`);
}

// ---- Control ------------------------------------------------------------------------------------

test('the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

// ---- Only the approval verifier and core's runtime build a DerivedActor -------------------------

test('the lint fails when a package casts an object to DerivedActor', { criterion: 'AC-SPEC-27-04', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/report/src/planted-actor.ts', [
    "import type { DerivedActor } from '@revisum/contracts';",
    '// A caller declaring its own actor type instead of getting it from the approval verifier.',
    "export const declaredActor = { actor: 'self-chosen', actorType: 'person-verified' } as DerivedActor;",
    '',
  ].join('\n'));
});

test('the lint fails when a package casts through unknown to DerivedActor', { criterion: 'AC-SPEC-27-04', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/cli/src/planted-actor.ts', [
    "import type { DerivedActor } from '@revisum/contracts';",
    "export const declaredActor = { actor: 'self-chosen', actorType: 'ci' } as unknown as DerivedActor;",
    '',
  ].join('\n'));
});

test('the lint fails when engine code outside the approval verifier brands a DerivedActor', { criterion: 'AC-SPEC-27-04', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/plan/planted-actor.ts', [
    "import type { ActorId, ActorType } from '@revisum/contracts';",
    "import { brand } from '../brand.ts';",
    "export const mintedActor = brand<{ actor: ActorId; actorType: ActorType }, 'DerivedActor'>(",
    "  { actor: brand<string, 'ActorId'>('self-chosen'), actorType: 'person-declared' },",
    ');',
    '',
  ].join('\n'));
});

test('the lint accepts code that only receives a DerivedActor and reads it', { criterion: 'AC-SPEC-27-04', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/report/src/planted-actor-reader.ts', [
    "import type { ActorType, DerivedActor } from '@revisum/contracts';",
    'export const actorTypeOf = (derived: DerivedActor): ActorType => derived.actorType;',
    '',
  ].join('\n'));
});

// ---- Branded values come only from their owning module ------------------------------------------

test('the lint fails when a package casts a string to SafeText', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/report/src/planted-cast.ts', [
    "import type { SafeText } from '@revisum/contracts';",
    "export const heading = 'Results' as SafeText;",
    '',
  ].join('\n'));
});

test('the lint fails when a driver casts through unknown to AllowedUrl', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/driver-cdp/src/planted-cast.ts', [
    "import type { AllowedUrl } from '@revisum/contracts';",
    "export const home = '/' as unknown as AllowedUrl;",
    '',
  ].join('\n'));
});

test('the lint fails when a package casts plan data to Plan', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/cli/src/planted-cast.ts', [
    "import type { Plan, PlanData } from '@revisum/contracts';",
    'export const forged = (data: PlanData): Plan => data as Plan;',
    '',
  ].join('\n'));
});

test('the lint fails on an angle-bracket cast to TargetId', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/runner/src/planted-cast.ts', [
    "import type { TargetId } from '@revisum/contracts';",
    "export const target = <TargetId>'chromium-desktop';",
    '',
  ].join('\n'));
});

test('the lint fails when engine code outside the parser casts a string to SafeText', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/planted-cast.ts', [
    "import type { SafeText } from '@revisum/contracts';",
    "export const label = 'Results' as SafeText;",
    '',
  ].join('\n'));
});

test('the lint accepts casts to types that are not branded', { criterion: 'AC-SPEC-27-05', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/report/src/planted-plain-cast.ts', [
    'export const parsed = JSON.parse(\'{"name":"x"}\') as { readonly name: string };',
    "export const sizes = ['small', 'large'] as const;",
    '',
  ].join('\n'));
});

// ---- A person is anyone in PERSON_ACTOR_TYPES ---------------------------------------------------

test("the lint fails on a gate that compares an actor type with 'person-verified' alone", { criterion: 'AC-SPEC-27-08', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/plan/planted-gate.ts', [
    "import type { ActorType } from '@revisum/contracts';",
    '// Lets only verified people through, so a declared approval would wrongly not count.',
    "export const mayApprove = (actorType: ActorType): boolean => actorType === 'person-verified';",
    '',
  ].join('\n'));
});

test("the lint fails on a reversed inequality against 'person-verified' alone", { criterion: 'AC-SPEC-27-08', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/report/src/planted-gate.ts', [
    "import type { ActorType } from '@revisum/contracts';",
    "export const excluded = (actorType: ActorType): boolean => 'person-verified' !== actorType;",
    '',
  ].join('\n'));
});

test('the lint accepts a gate that tests membership of PERSON_ACTOR_TYPES', { criterion: 'AC-SPEC-27-08', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/engine/src/plan/planted-gate.ts', [
    "import { PERSON_ACTOR_TYPES, type ActorType } from '@revisum/contracts';",
    'export const mayApprove = (actorType: ActorType): boolean => PERSON_ACTOR_TYPES.includes(actorType);',
    '',
  ].join('\n'));
});
