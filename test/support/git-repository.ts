// A throw-away Git repository built by a test, for checks that read commit history. Git runs with
// no global or system configuration, so the founder's own settings (hooks, signing, line-ending
// conversion) never change what a fixture commit holds, and every commit has a fixed author.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type FixtureCommit = {
  // Files to write before committing, by path relative to the repository root.
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  // Files to delete before committing.
  readonly removed?: readonly string[];
  readonly message: string;
};

export type GitRepository = {
  readonly root: string;
  // The environment every command in this repository should run with, tools included.
  readonly environment: NodeJS.ProcessEnv;
  // Writes the files, commits them with the message, and returns the new commit's full hash.
  commit(fixture: FixtureCommit): string;
  // Writes a file without committing it.
  write(relativePath: string, content: string | Uint8Array): void;
  git(...words: readonly string[]): string;
  dispose(): void;
};

export function createGitRepository(): GitRepository {
  const folder = mkdtempSync(join(tmpdir(), 'revisum-git-'));
  const root = join(folder, 'repository');
  mkdirSync(root);
  const emptyConfig = join(folder, 'empty-gitconfig');
  writeFileSync(emptyConfig, '');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture.author@example.com',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture.author@example.com',
  };

  const git = (...words: readonly string[]): string =>
    execFileSync('git', words, { cwd: root, ['env']: environment, encoding: 'utf8' }).trim();
  const write = (relativePath: string, content: string | Uint8Array): void => {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  git('init', '--quiet');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');

  return {
    root,
    environment,
    git,
    write,
    commit(fixture) {
      for (const [relativePath, content] of Object.entries(fixture.files ?? {})) write(relativePath, content);
      for (const relativePath of fixture.removed ?? []) rmSync(join(root, relativePath), { force: true });
      git('add', '--all');
      execFileSync('git', ['commit', '--quiet', '--allow-empty', '--file', '-'], {
        cwd: root, ['env']: environment, input: fixture.message, encoding: 'utf8',
      });
      return git('rev-parse', 'HEAD');
    },
    dispose() {
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
