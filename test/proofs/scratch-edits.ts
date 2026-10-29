// Edits several files of a scratch copy of the repository at once, runs something, then puts
// every file back, so a test can plant a change that spans files (a manifest and its lock file,
// say) and check the lint sees it. Also the assertions the lint tests share.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LintOutcome, ScratchRepository } from './scratch-repository.ts';

// A new file's text, or a function from the current text to the new text.
export type FileEdit = string | ((text: string) => string);

export function withEdits<Result>(root: string, edits: Readonly<Record<string, FileEdit>>, run: () => Result): Result {
  const originals = new Map<string, string | null>();
  try {
    for (const [relativePath, edit] of Object.entries(edits)) {
      const path = join(root, relativePath);
      const original = existsSync(path) ? readFileSync(path, 'utf8') : null;
      originals.set(path, original);
      const edited = typeof edit === 'string' ? edit : edit(original ?? '');
      if (edited === original) throw new Error(`the edit left ${relativePath} unchanged`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, edited);
    }
    return run();
  } finally {
    for (const [path, original] of originals) {
      if (original === null) rmSync(path, { force: true });
      else writeFileSync(path, original);
    }
  }
}

export function lintWithEdits(scratch: ScratchRepository, edits: Readonly<Record<string, FileEdit>>): LintOutcome {
  return withEdits(scratch.root, edits, () => scratch.lint());
}

// Rewrites a JSON file through a function on its parsed value, keeping two-space indentation.
export function editJson(change: (value: Record<string, unknown>) => void): (text: string) => string {
  return (text) => {
    const value: Record<string, unknown> = JSON.parse(text);
    change(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  };
}

export function assertLintPasses(outcome: LintOutcome): void {
  assert.equal(outcome.passed, true, `the lint failed:\n${outcome.failureOutput}`);
}

// The lint failed, and its failure output names every one of `expected`. When `tool` is given,
// the command that runs that tool is one of those that failed.
export function assertLintFails(outcome: LintOutcome, expected: readonly string[], tool?: string): void {
  assert.equal(outcome.passed, false, 'the lint passed');
  for (const text of expected) {
    assert.ok(outcome.failureOutput.includes(text), `the lint failed, but its output does not name "${text}":\n${outcome.failureOutput}`);
  }
  if (tool !== undefined) {
    const failedCommands = outcome.commands.filter((command) => command.status !== 0).map((command) => command.command);
    assert.ok(failedCommands.some((command) => command.includes(tool)),
      `the lint failed, but not in ${tool}; failed commands: ${failedCommands.join(', ')}\n${outcome.failureOutput}`);
  }
}
