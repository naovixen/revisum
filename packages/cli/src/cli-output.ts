// What every command prints with --json: one CliOutput object, with the schema id, the command,
// whether it succeeded, its data and its typed errors. Each error links to its heading in
// docs/errors.md. The full command line lives elsewhere; the types are here, in the package that owns
// the command line.
import { schemaId, type CliErrorCode, type ExitCode } from '@revisum/engine';

export type Command = 'validate' | 'lock' | 'run' | 'export' | 'review' | 'approve' | 'doctor' | 'convert' | 'draft';
export type CliError = { readonly code: CliErrorCode; readonly path?: string; readonly docs: `errors#${CliErrorCode}` };
export type CliOutput<Data> = {
  readonly schema: string; readonly command: Command; readonly ok: boolean; readonly data?: Data; readonly errors?: readonly CliError[];
  // What went wrong closing a browser session the command used. It changes nothing the command found.
  readonly closeFailure?: string;
};

// What a command answers with: its exit code and the text it prints on each stream.
export type CommandOutcome = { readonly exitCode: ExitCode; readonly stdout: string; readonly stderr: string };

export const CLI_OUTPUT_SCHEMA = schemaId('cli', 1);

export const cliError = (code: CliErrorCode, path?: string): CliError => ({ code, ...(path === undefined ? {} : { path }), docs: `errors#${code}` });

// The exit code a failed command ends with, from the run's codes (0 passed, 1 failed, 2 plan
// rejected, 3 a required target unavailable, 4 internal error, 5 needs review). A refused plan or
// approval, or a plan with none, is 2 and an unavailable target 3; anything else that stops a
// command before it can do its work is 4.
export function exitCodeFor(code: CliErrorCode): ExitCode {
  switch (code) {
    case 'plan-rejected': case 'approval-refused': case 'after-plan-unapproved':
      return 2;
    case 'target-unavailable':
      return 3;
    case 'usage': case 'config-invalid': case 'untrusted-source': case 'lock-download-failed': case 'lock-offline': case 'replay-mismatch':
    case 'internal': case 'planner-endpoint-not-loopback': case 'planner-call-failed':
    case 'explore-origin-refused': case 'explore-runner-unavailable': case 'explore-start-unreachable':
      return 4;
  }
}
