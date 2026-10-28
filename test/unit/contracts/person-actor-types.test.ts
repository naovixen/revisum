// Who counts as a person: anyone whose actor type is in PERSON_ACTOR_TYPES. A declared person
// counts exactly as a verified one; agents, CI and unverified sources never count.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSON_ACTOR_TYPES, type ActorType } from '@revisum/contracts';

const EVERY_ACTOR_TYPE = ['person-verified', 'person-declared', 'agent', 'ci', 'unverified'] as const satisfies readonly ActorType[];
// Fails to compile if ActorType gains a member this list does not hold, so no type is left untested.
const listsEveryActorType: [Exclude<ActorType, (typeof EVERY_ACTOR_TYPE)[number]>] extends [never] ? true : false = true;

const countsAsPerson = (actorType: ActorType): boolean => PERSON_ACTOR_TYPES.includes(actorType);

test('every actor type is listed, so the checks below cover them all', { criterion: 'AC-SPEC-27-08' }, () => {
  assert.equal(listsEveryActorType, true);
});

test('a declared person counts as a person exactly as a verified person does', { criterion: 'AC-SPEC-27-08' }, () => {
  assert.equal(countsAsPerson('person-declared'), true);
  assert.equal(countsAsPerson('person-verified'), true);
});

test('an agent, CI or an unverified source never counts as a person', { criterion: 'AC-SPEC-27-08' }, () => {
  for (const actorType of ['agent', 'ci', 'unverified'] as const) {
    assert.equal(countsAsPerson(actorType), false, `${actorType} counted as a person`);
  }
});

test('the person actor types are exactly the two person types, with no duplicates', { criterion: 'AC-SPEC-27-08' }, () => {
  const persons = EVERY_ACTOR_TYPE.filter(countsAsPerson);
  assert.deepEqual(persons, ['person-verified', 'person-declared']);
  assert.equal(PERSON_ACTOR_TYPES.length, 2);
});
