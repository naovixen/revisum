// The minimal audit event sink: one JSON Lines entry per event, appended, never rewritten. If
// anything else truncates or rewrites the file, the next append is refused as not-append-only.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { jsonLinesEventSink, type ActorType, type DerivedActor, type EventInput, type EventSink } from '@revisum/engine';

// Only the approval verifier and core's runtime mint a DerivedActor. The sink needs one, and no
// minting code exists for tests, so this helper is the one place here that builds it directly.
const derivedActor = (actor: string, actorType: ActorType): DerivedActor => ({ actor, actorType }) as DerivedActor;

const FOUNDER = derivedActor('actor-hash-founder', 'person-declared');
const AGENT = derivedActor('actor-hash-agent', 'agent');

const SUBMITTED: EventInput = { kind: 'plan.submitted', runId: 'run-0001', subjectHash: 'plan-hash-1', criterionIds: ['signup.creates-account'] };
const APPROVED: EventInput = { kind: 'plan.approved', runId: 'run-0001', subjectHash: 'plan-hash-1' };
const FINISHED: EventInput = { kind: 'run.finished', runId: 'run-0001' };

let folder: string;
let path: string;
let sink: EventSink;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'event-sink-'));
  path = join(folder, 'audit.jsonl');
  sink = jsonLinesEventSink(path);
});
afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

const readText = (): string => readFileSync(path, 'utf8');
const entries = (): Record<string, unknown>[] =>
  readText().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);

function appendOk(event: EventInput, actor: DerivedActor): number {
  const appended = sink.append(event, actor);
  assert.equal(appended.ok, true, `append was refused: ${JSON.stringify(appended)}`);
  return appended.ok ? appended.value.sequence : Number.NaN;
}

// ---- One entry per event ------------------------------------------------------------------------

test('writes exactly one newline-terminated JSON line per appended event, in order', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  appendOk(APPROVED, FOUNDER);
  appendOk(FINISHED, FOUNDER);

  const text = readText();
  assert.ok(text.endsWith('\n'), 'the last entry ends with a newline');
  const written = entries();
  assert.equal(written.length, 3);
  assert.deepEqual(written.map((entry) => entry['kind']), ['plan.submitted', 'plan.approved', 'run.finished']);
});

test('each entry records the event and the derived actor it was appended with', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  appendOk(APPROVED, FOUNDER);

  const [submitted, approved] = entries();
  assert.equal(submitted?.['runId'], 'run-0001');
  assert.equal(submitted?.['subjectHash'], 'plan-hash-1');
  assert.deepEqual(submitted?.['criterionIds'], ['signup.creates-account']);
  assert.equal(submitted?.['actor'], 'actor-hash-agent');
  assert.equal(submitted?.['actorType'], 'agent');
  assert.equal(approved?.['actor'], 'actor-hash-founder');
  assert.equal(approved?.['actorType'], 'person-declared');
});

test('returns consecutive sequence numbers, one per appended event', { criterion: 'AC-SPEC-27-03' }, () => {
  const first = appendOk(SUBMITTED, AGENT);
  const second = appendOk(APPROVED, FOUNDER);
  const third = appendOk(FINISHED, FOUNDER);
  assert.ok(Number.isInteger(first) && first >= 0, `first sequence ${first}`);
  assert.deepEqual([second, third], [first + 1, first + 2]);
});

// ---- Earlier lines never change -----------------------------------------------------------------

test('leaves every earlier line byte for byte unchanged when later events are appended', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  const afterOne = readText();
  appendOk(APPROVED, FOUNDER);
  const afterTwo = readText();
  appendOk(FINISHED, FOUNDER);
  const afterThree = readText();

  assert.ok(afterTwo.length > afterOne.length && afterTwo.startsWith(afterOne), 'the first line was changed by the second append');
  assert.ok(afterThree.length > afterTwo.length && afterThree.startsWith(afterTwo), 'earlier lines were changed by the third append');
});

// ---- Truncation and rewriting are refused -------------------------------------------------------

test('refuses the next append with not-append-only after the file was truncated to its first line', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  const firstLine = readText();
  appendOk(APPROVED, FOUNDER); // the control: while only the sink writes, appends are accepted

  truncateSync(path, Buffer.byteLength(firstLine));
  assert.deepEqual(sink.append(FINISHED, FOUNDER), { ok: false, error: { code: 'not-append-only' } });
  assert.equal(readText(), firstLine, 'the refused append still wrote to the file');
});

test('refuses the next append with not-append-only after the file was emptied', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  truncateSync(path, 0);
  assert.deepEqual(sink.append(APPROVED, FOUNDER), { ok: false, error: { code: 'not-append-only' } });
  assert.equal(readText(), '');
});

test('refuses the next append with not-append-only after an earlier line was rewritten', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  appendOk(APPROVED, FOUNDER);
  // Someone relabels the agent's event as a person's.
  const rewritten = readText().replace('"agent"', '"person-verified"');
  assert.notEqual(rewritten, readText(), 'the rewrite changed the file');
  writeFileSync(path, rewritten);

  assert.deepEqual(sink.append(FINISHED, FOUNDER), { ok: false, error: { code: 'not-append-only' } });
  assert.equal(readText(), rewritten, 'the refused append still wrote to the file');
});

test('refuses the next append with not-append-only after an earlier line was rewritten to the same length', { criterion: 'AC-SPEC-27-03' }, () => {
  appendOk(SUBMITTED, AGENT);
  appendOk(APPROVED, FOUNDER);
  // A same-size edit: a check of the file's length alone would miss it.
  const original = readText();
  const rewritten = original.replace('plan-hash-1', 'plan-hash-9');
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
  assert.notEqual(rewritten, original);
  writeFileSync(path, rewritten);

  assert.deepEqual(sink.append(FINISHED, FOUNDER), { ok: false, error: { code: 'not-append-only' } });
  assert.equal(readText(), rewritten, 'the refused append still wrote to the file');
});
