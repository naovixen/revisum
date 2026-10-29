// The commit-trailer grammar the project's own metrics are read from. The main session checks
// each message before committing (`node tools/check-commit-trailers.ts --message <file>`),
// because a malformed commit can never be amended. The grammar, in Git's trailer block:
//   Agent: <tool>/<semantic version>   at most once; the tool part is lower case
//   Spec: SPEC-nn                      once per spec; names a file in docs/specs/
//   Criteria: <criterion id>[, …]      each id exists in docs/specs/
// A near-miss key, a value that breaks its grammar or names nothing, or a Co-Authored-By trailer
// naming Claude without an Agent trailer is malformed. Other trailers are ignored.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { criterionId, specId } from '../support/criterion-ids.ts';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const folder = mkdtempSync(join(tmpdir(), 'revisum-trailers-'));
after(() => { rmSync(folder, { recursive: true, force: true }); });

let messageCount = 0;
function checkMessage(message: string): ToolRun {
  messageCount += 1;
  const path = join(folder, `message-${messageCount}.txt`);
  writeFileSync(path, message);
  return runTool('check-commit-trailers.ts', ['--message', path], { cwd: REPOSITORY_ROOT });
}

const CO_AUTHOR_CLAUDE = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const AGENT = 'Agent: claude-code/2.1.312';
const SUBJECT = 'Build the dependency review lint\n\nChecks every runtime package against its review.\n';

const messageWith = (...trailers: readonly string[]): string => `${SUBJECT}\n${trailers.join('\n')}\n`;

function assertAccepted(message: string): void {
  const run = checkMessage(message);
  assert.equal(run.passed, true, `the message was refused:\n${message}\n${describeRun(run)}`);
}

function assertRefused(message: string, named: string): void {
  const run = checkMessage(message);
  assert.equal(run.passed, false, `the message was accepted:\n${message}`);
  assert.ok(run.output.includes(named), `the refusal does not name "${named}":\n${describeRun(run)}`);
}

// ---- Well-formed messages -----------------------------------------------------------------------

test('a message with all three trailers, a co-author and an unrelated trailer is accepted', { criterion: 'AC-SPEC-00-07' }, () => {
  assertAccepted(messageWith(
    AGENT,
    `Spec: ${specId(0)}`,
    `Criteria: ${criterionId(0, 4)}, ${criterionId(0, 7)}`,
    CO_AUTHOR_CLAUDE,
    'Claude-Session: https://claude.ai/code/session_fixture',
  ));
});

test('a message implementing two specs, with one Spec trailer for each, is accepted', { criterion: 'AC-SPEC-00-07' }, () => {
  assertAccepted(messageWith(AGENT, `Spec: ${specId(0)}`, `Spec: ${specId(1)}`, `Criteria: ${criterionId(0, 5)}, ${criterionId(1, 1)}`, CO_AUTHOR_CLAUDE));
});

test('a person\'s message with no trailers is accepted', { criterion: 'AC-SPEC-00-07' }, () => {
  assertAccepted('Fix a typo in the README\n');
});

test('a co-author who is a person needs no Agent trailer', { criterion: 'AC-SPEC-00-07' }, () => {
  assertAccepted(messageWith('Co-Authored-By: Ada Lovelace <ada@example.com>'));
});

// ---- Values that break their grammar or name nothing --------------------------------------------

test('an Agent trailer whose version is not a semantic version is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith('Agent: claude-code/latest', CO_AUTHOR_CLAUDE), 'claude-code/latest');
});

test('an Agent trailer whose tool is not a lower-case name is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith('Agent: Claude Code/2.1.312', CO_AUTHOR_CLAUDE), 'Claude Code/2.1.312');
});

test('two Agent trailers in one message are refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith(AGENT, 'Agent: claude-code/2.1.313', CO_AUTHOR_CLAUDE), 'Agent');
});

test('a Spec trailer naming a spec with no file in docs/specs is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith(AGENT, `Spec: ${specId(99)}`, CO_AUTHOR_CLAUDE), specId(99));
});

test('a Spec trailer that is not of the form SPEC-nn is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith(AGENT, 'Spec: repo seed and gates', CO_AUTHOR_CLAUDE), 'repo seed and gates');
});

test('a Criteria trailer naming a criterion that does not exist is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith(AGENT, `Spec: ${specId(0)}`, `Criteria: ${criterionId(0, 4)}, ${criterionId(0, 99)}`, CO_AUTHOR_CLAUDE), criterionId(0, 99));
});

test('a Criteria trailer whose ids are not separated by commas is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith(AGENT, `Criteria: ${criterionId(0, 4)} ${criterionId(0, 5)}`, CO_AUTHOR_CLAUDE), 'Criteria');
});

// ---- Near-miss keys and a missing Agent trailer -------------------------------------------------

for (const [nearMiss, value] of [['agent', 'claude-code/2.1.312'], ['Specs', specId(0)], ['Criterion', criterionId(0, 4)]] as const) {
  test(`the near-miss key "${nearMiss}:" is refused`, { criterion: 'AC-SPEC-00-07' }, () => {
    const trailers = nearMiss === 'agent' ? [`${nearMiss}: ${value}`, CO_AUTHOR_CLAUDE] : [AGENT, `${nearMiss}: ${value}`, CO_AUTHOR_CLAUDE];
    assertRefused(messageWith(...trailers), nearMiss);
  });
}

test('a Co-Authored-By trailer naming Claude without an Agent trailer is refused', { criterion: 'AC-SPEC-00-07' }, () => {
  assertRefused(messageWith(`Spec: ${specId(0)}`, CO_AUTHOR_CLAUDE), 'Agent');
});
