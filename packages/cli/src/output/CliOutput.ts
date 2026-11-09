// What every command prints with --json: one CliOutput object, with the schema id, the command,
// whether it succeeded, its data and its typed errors. Each error links to its heading in
// docs/errors.md. The full command line lives elsewhere; the types are here, in the package that owns
// the command line.
import { schemaId, CliErrorCode, type ExitCode } from '@revisum/engine';

export type Command = 'validate' | 'lock' | 'run' | 'export' | 'review' | 'approve' | 'doctor' | 'convert' | 'draft';
// `reason` says what went wrong, when that holds no input value and helps a person more than the code.
export type CliError = { readonly code: CliErrorCode; readonly path?: string; readonly reason?: string; readonly docs: `errors#${CliErrorCode}` };
export type CliOutput<Data> = {
  readonly schema: string; readonly command: Command; readonly ok: boolean; readonly data?: Data; readonly errors?: readonly CliError[];
  // What went wrong closing a browser session the command used, or with its egress proxy while that
  // ran. It changes nothing the command found.
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
    case CliErrorCode.PlanRejected: case CliErrorCode.ApprovalRefused: case CliErrorCode.AfterPlanUnapproved:
      return 2;
    case CliErrorCode.TargetUnavailable:
      return 3;
    case CliErrorCode.Usage: case CliErrorCode.ConfigInvalid: case CliErrorCode.UntrustedSource: case CliErrorCode.LockDownloadFailed: case CliErrorCode.LockOffline: case CliErrorCode.ReplayMismatch:
    case CliErrorCode.Internal: case CliErrorCode.PlannerEndpointNotLoopback: case CliErrorCode.PlannerCallFailed:
    case CliErrorCode.ExploreOriginRefused: case CliErrorCode.ExploreRunnerUnavailable: case CliErrorCode.ExploreStartUnreachable:
      return 4;
  }
}
