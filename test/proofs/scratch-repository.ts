// A throw-away copy of the repository, so a test can plant a file that breaks a rule and run the
// repository's own lint commands over it without touching the working tree. The lint commands are
// read from package.json, so whichever tool enforces a rule, the test sees it fail.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPOSITORY_ROOT } from '../support/repository.ts';

export type CommandOutcome = { readonly command: string; readonly status: number | null; readonly output: string };

export type LintOutcome = {
  readonly passed: boolean;
  readonly commands: readonly CommandOutcome[];
  // The output of every command that failed, for assertion messages.
  readonly failureOutput: string;
};

export type ScratchRepository = {
  readonly root: string;
  // Writes a file at a path relative to the copy's root, runs every lint command, then removes it.
  lintWith(relativePath: string, source: string): LintOutcome;
  // Rewrites an existing file with `edit`, runs every lint command, then restores the original.
  lintWithEdit(relativePath: string, edit: (text: string) => string): LintOutcome;
  lint(): LintOutcome;
  dispose(): void;
};

// The package.json scripts that make up "the lint".
const LINT_SCRIPTS = ['lint', 'lint:names'];

function repositoryFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: REPOSITORY_ROOT, encoding: 'utf8',
  });
  return listed.split('\0').filter((path) => path !== '' && existsSync(join(REPOSITORY_ROOT, path)));
}

function lintCommands(root: string): string[][] {
  const manifest: { readonly scripts?: Readonly<Record<string, string>> } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commands: string[][] = [];
  for (const script of LINT_SCRIPTS) {
    const line = manifest.scripts?.[script];
    if (line === undefined) throw new Error(`package.json has no "${script}" script`);
    for (const command of line.split('&&')) {
      const words = command.trim().split(/\s+/);
      if (words[0] !== 'node') throw new Error(`lint command "${command.trim()}" does not start with node; teach scratch-repository.ts to run it`);
      commands.push(words.slice(1));
    }
  }
  return commands;
}

export function copyRepository(): ScratchRepository {
  const root = mkdtempSync(join(tmpdir(), 'repository-'));
  for (const path of repositoryFiles()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  // Installed tools, for any lint that needs the compiler. A junction needs no rights on Windows.
  const modules = join(root, 'node_modules');
  symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), modules, 'junction');

  const lint = (): LintOutcome => {
    const commands = lintCommands(root).map((words): CommandOutcome => {
      const ran = spawnSync(process.execPath, words, { cwd: root, encoding: 'utf8', timeout: 240_000 });
      return { command: words.join(' '), status: ran.status, output: (ran.stdout ?? '') + (ran.stderr ?? '') };
    });
    const failed = commands.filter((command) => command.status !== 0);
    return {
      passed: failed.length === 0,
      commands,
      failureOutput: failed.map((command) => `$ node ${command.command}\n${command.output}`).join('\n'),
    };
  };

  return {
    root,
    lint,
    lintWith(relativePath, source) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
      try {
        return lint();
      } finally {
        rmSync(path, { force: true });
      }
    },
    lintWithEdit(relativePath, edit) {
      const path = join(root, relativePath);
      const original = readFileSync(path, 'utf8');
      const edited = edit(original);
      if (edited === original) throw new Error(`the edit left ${relativePath} unchanged`);
      writeFileSync(path, edited);
      try {
        return lint();
      } finally {
        writeFileSync(path, original);
      }
    },
    dispose() {
      // Remove the link first, so deleting the copy can never reach the real node_modules.
      if (existsSync(modules)) unlinkSync(modules);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
