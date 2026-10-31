// The planner endpoint in the trusted project.json. An API key never travels over plain HTTP, so a
// customer-key endpoint must be https:, and the project parser refuses an http: one with its
// existing code for a URL whose scheme is not allowed, at the endpoint's url. A local endpoint,
// which the draft command keeps to loopback, may be http:.
// See docs/specs/SPEC-37-explore-to-draft.md and docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject } from '@revisum/engine';
import { customerKeyPlanner, localPlanner, projectFile, PLANNER_HOST } from '../cli/draft-command-examples.ts';

// The fields every endpoint keeps as written: its kind, address, model and wire format.
const keptFields = (endpoint: unknown): readonly unknown[] =>
  ['kind', 'url', 'model', 'wire'].map((field) => (typeof endpoint === 'object' && endpoint !== null ? Reflect.get(endpoint, field) : undefined));

test('a customer-key endpoint over plain http is refused with scheme_not_allowed at its url', { criterion: 'AC-SPEC-37-13' }, () => {
  for (const wire of ['anthropic-messages', 'openai-chat'] as const) {
    const parsed = parseProject(projectFile(customerKeyPlanner(wire, `http://${PLANNER_HOST}`)));
    assert.equal(parsed.ok, false, `${wire}: the http endpoint was accepted`);
    if (!parsed.ok) assert.deepEqual(parsed.error, [{ code: 'scheme_not_allowed', path: '$.planner.url' }]);
  }
});

test('counter-example: the same endpoint over https is accepted and kept', { criterion: 'AC-SPEC-37-13' }, () => {
  const planner = customerKeyPlanner('anthropic-messages');
  const parsed = parseProject(projectFile(planner));
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error));
  assert.deepEqual(keptFields(Reflect.get(parsed.value, 'planner')), keptFields(planner));
});

test('a local endpoint on loopback may be plain http', { criterion: 'AC-SPEC-37-13' }, () => {
  const planner = localPlanner('http://127.0.0.1:11434');
  const parsed = parseProject(projectFile(planner));
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error));
  assert.deepEqual(keptFields(Reflect.get(parsed.value, 'planner')), keptFields(planner));
});
