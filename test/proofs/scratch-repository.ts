// A throw-away copy of the repository, so a test can plant a file that breaks a rule and run the
// repository's own lint over it without touching the working tree. With no rule named, every lint
// command runs, read from package.json, so whichever tool enforces a rule the test sees it fail,
// and a form valid for one tool is shown not to fail another. Naming a rule runs only that rule,
// still as a process in the copy, so planted edits under tools/ run the planted code. Which rules
// `npm run lint` runs is proved once, in RunRepositoryRules.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RepositoryRuleName } from '../../tools/RunRepositoryRules.ts';
import { REPOSITORY_ROOT } from '../support/repository.ts';

export type CommandOutcome = { readonly command: string; readonly status: number | null; readonly output: string };

export type LintOutcome = {
  readonly passed: boolean;
  readonly commands: readonly CommandOutcome[];
  // The output of every command that failed, for assertion messages.
  readonly failureOutput: string;
};

export type LintChoice = {
  // Only this rule; every lint command when left out.
  readonly rule?: RepositoryRuleName;
  // An installed-packages folder for the licence rule, in place of node_modules.
  readonly modulesFolder?: string;
};

export type ScratchRepository = {
  // The copy's folder. It is copied on the first call, so tests that never lint don't pay for it.
  root(): string;
  // Writes a file at a path relative to the copy's root, runs the lint, then removes it.
  lintWith(relativePath: string, source: string, choice?: LintChoice): LintOutcome;
  // Rewrites an existing file with `edit`, runs the lint, then restores the original.
  lintWithEdit(relativePath: string, edit: (text: string) => string, choice?: LintChoice): LintOutcome;
  lint(choice?: LintChoice): LintOutcome;
  dispose(): void;
};

// The package.json scripts that make up "the lint".
const LINT_SCRIPTS = ['lint', 'lint:names'];
const RULES_TOOL = 'tools/RunRepositoryRules.ts';
// More than half the repository's files, and no lint rule's input: no rule reads what's in them,
// and no glossary row or dependency review cites a path there. A rule that started to would fail
// every control in the copy, loudly.
const FOLDERS_NO_RULE_READS = ['fixtures/'];

function repositoryFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: REPOSITORY_ROOT, encoding: 'utf8',
  });
  return listed.split('\0').filter((path) =>
    path !== '' && !FOLDERS_NO_RULE_READS.some((folder) => path.startsWith(folder)) && existsSync(join(REPOSITORY_ROOT, path)));
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

function chosenCommands(root: string, { rule, modulesFolder }: LintChoice): string[][] {
  const modulesWords = modulesFolder === undefined ? [] : ['--modules', modulesFolder];
  if (rule !== undefined) {
    return [[RULES_TOOL, '--only', rule, ...modulesWords]];
  }
  return lintCommands(root).map((words) => (words[0] === RULES_TOOL ? [...words, ...modulesWords] : words));
}

function copyFilesTo(root: string): void {
  for (const path of repositoryFiles()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  // Installed tools, for any lint that needs the compiler. A junction needs no rights on Windows.
  symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
}

export function copyRepository(): ScratchRepository {
  let copiedRoot: string | undefined;

  const copied = (): string => {
    if (copiedRoot !== undefined) {
      return copiedRoot;
    }
    const root = mkdtempSync(join(tmpdir(), 'repository-'));
    copiedRoot = root;
    copyFilesTo(root);
    return root;
  };

  const lint = (choice: LintChoice = {}): LintOutcome => {
    const root = copied();
    const commands = chosenCommands(root, choice).map((words): CommandOutcome => {
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
    root: copied,
    lint,
    lintWith(relativePath, source, choice) {
      const path = join(copied(), relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
      try {
        return lint(choice);
      } finally {
        rmSync(path, { force: true });
      }
    },
    lintWithEdit(relativePath, edit, choice) {
      const path = join(copied(), relativePath);
      const original = readFileSync(path, 'utf8');
      const edited = edit(original);
      if (edited === original) throw new Error(`the edit left ${relativePath} unchanged`);
      writeFileSync(path, edited);
      try {
        return lint(choice);
      } finally {
        writeFileSync(path, original);
      }
    },
    dispose() {
      if (copiedRoot === undefined) {
        return;
      }
      // Remove the link first, so deleting the copy can never reach the real node_modules.
      const modules = join(copiedRoot, 'node_modules');
      if (existsSync(modules)) unlinkSync(modules);
      rmSync(copiedRoot, { recursive: true, force: true });
    },
  };
}
