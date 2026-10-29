// Runs one of the repository's own tools as a separate Node process, the way CI runs it, and
// keeps its exit status and everything it printed. Tools read the repository they check from
// their working folder, so a test points `cwd` at a fixture repository or a scratch copy.
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { REPOSITORY_ROOT } from './repository.ts';

export type ToolRun = {
  readonly status: number | null;
  readonly passed: boolean;
  // Standard output and standard error together, for assertions and failure messages.
  readonly output: string;
};

export type ToolRunOptions = {
  // The folder the tool treats as the repository root.
  readonly cwd: string;
  readonly input?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeout?: number;
};

// Runs `tools/<name>` from this repository (or `script` as given when it is absolute).
export function runTool(script: string, words: readonly string[], options: ToolRunOptions): ToolRun {
  const path = isAbsolute(script) ? script : join(REPOSITORY_ROOT, 'tools', script);
  // Node's test runner marks its child processes through this variable; a tool that runs tests
  // itself would otherwise report to this test run instead of exiting with its own status.
  const environment = { ...(options.environment ?? process.env) };
  delete environment['NODE_TEST_CONTEXT'];
  const ran = spawnSync(process.execPath, [path, ...words], {
    cwd: options.cwd,
    ['env']: environment,
    encoding: 'utf8',
    ...(options.input === undefined ? {} : { input: options.input }),
    timeout: options.timeout ?? 240_000,
  });
  const output = `${ran.stdout ?? ''}${ran.stderr ?? ''}${ran.error === undefined ? '' : String(ran.error)}`;
  return { status: ran.status, passed: ran.status === 0, output };
}

export function describeRun(run: ToolRun): string {
  return `exit status ${String(run.status)}\n${run.output}`;
}
