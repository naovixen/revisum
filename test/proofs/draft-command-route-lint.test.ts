// Route code produces drafts, never runs. The draft command's module may not import the engine's
// run function, nor make a Plan by a cast: what it hands on is a draft, which only the plan parser
// turns into a Plan. Each test edits that module, or plants a file, in a throw-away copy of the
// repository and runs the repository's lint commands over it. The counter-example shows the rule
// is about route code, not about every command-line module.
//
// Assumed here: the draft command lives in packages/cli/src/draft-command.ts.
// See docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

const DRAFT_COMMAND_MODULE = 'packages/cli/src/draft-command.ts';
const DRAFT_COMMAND_FILE = 'draft-command.ts';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

// The module with `lines` put before its own text.
const withLinesFirst = (lines: readonly string[]) => (text: string): string => `${lines.join('\n')}\n${text}`;

function assertLintFailsNamingTheModule(lines: readonly string[]): void {
  assert.ok(existsSync(join(scratch.root, DRAFT_COMMAND_MODULE)), `${DRAFT_COMMAND_MODULE} does not exist`);
  const outcome = scratch.lintWithEdit(DRAFT_COMMAND_MODULE, withLinesFirst(lines));
  assert.equal(outcome.passed, false, `the lint accepted the draft command module with:\n${lines.join('\n')}`);
  assert.ok(outcome.failureOutput.includes(DRAFT_COMMAND_FILE), `the lint failed, but did not name ${DRAFT_COMMAND_FILE}:\n${outcome.failureOutput}`);
}

test('control: the draft command module exists and the unchanged copy passes every lint command', { criterion: 'AC-SPEC-28-04', timeout: TIMEOUT }, () => {
  assert.ok(existsSync(join(scratch.root, DRAFT_COMMAND_MODULE)), `${DRAFT_COMMAND_MODULE} does not exist`);
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

test('the lint fails when the draft command module imports the engine\'s run function', { criterion: 'AC-SPEC-28-04', timeout: TIMEOUT }, () => {
  assertLintFailsNamingTheModule([
    "import { run } from '@revisum/engine';",
    '// Runs the draft straight away, skipping approval.',
    'export const runDraftAtOnce = run;',
  ]);
});

test('the lint fails when the draft command module imports run under another name', { criterion: 'AC-SPEC-28-04', timeout: TIMEOUT }, () => {
  assertLintFailsNamingTheModule([
    "import { run as startRun } from '@revisum/engine';",
    'export const startDraftRun = startRun;',
  ]);
});

test('the lint fails when the draft command module makes a Plan by a cast', { criterion: 'AC-SPEC-28-04', timeout: TIMEOUT }, () => {
  assertLintFailsNamingTheModule([
    "import type { Plan } from '@revisum/contracts';",
    '// Treats the planner\'s reply as a plan, skipping the parser.',
    'export const plannedAsPlan = (reply: unknown): Plan => reply as Plan;',
  ]);
});

test('counter-example: a command-line module that is not route code may import run', { criterion: 'AC-SPEC-28-04', timeout: TIMEOUT }, () => {
  const outcome = scratch.lintWith('packages/cli/src/planted-run-wiring.ts', [
    "import { run } from '@revisum/engine';",
    '// The run command wires the engine\'s run function to the drivers.',
    'export const startRun = run;',
    '',
  ].join('\n'));
  assert.equal(outcome.passed, true, `the lint refused run outside route code:\n${outcome.failureOutput}`);
});
