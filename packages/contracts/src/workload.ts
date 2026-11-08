// The workload runner's port: a team's own image, pinned by digest, runs one argument vector behind
// the same egress proxy and hardening as the isolated runner. Evidence mode runs a team's
// Playwright suite through it. The types live here so cli can join engine and runner without
// either importing the other.
import type { ImageDigest } from './evidence-mode.ts';
import { ContainerRefusalCode } from './ContainerRefusalCode.ts';
import type { EgressEvent, EgressPolicy } from './isolated-runner.ts';
import type { Result } from './result.ts';
import type { Secret } from './secret.ts';
import type { DeclaredService } from './service-calls.ts';

// Where the workload container sees the repository under test (read-only) and Revisum's output
// folder (the only writable mount apart from a private /tmp). An argument vector or variable that
// names a path inside the container uses these.
export const WORKLOAD_CHECKOUT_PATH = '/workload/checkout';
export const WORKLOAD_OUTPUT_PATH = '/workload/output';

// A variable the workload's process receives. A secret stays opaque until the runner writes the
// container's environment.
export type WorkloadVariable = { readonly name: string; readonly value: string | Secret };

export type WorkloadRequest = {
  readonly image: ImageDigest;
  // Run as it is, without a shell.
  readonly argv: readonly string[];
  // Repository-relative, inside the checkout.
  readonly workingDirectory: string;
  readonly environment: readonly WorkloadVariable[];
  readonly policy: EgressPolicy;
  readonly timeoutMilliseconds: number;
  // The host folder Revisum owns for the workload's output, mounted at WORKLOAD_OUTPUT_PATH.
  readonly outputDirectory: string;
  // The declared services the policy's allowTcpServices name, so the proxy knows each one's address
  // and port. Absent: none.
  readonly services?: readonly DeclaredService[];
  // False for a command that speaks only TCP, such as a database client: its environment then holds
  // no proxy variables. True when absent.
  readonly httpProxyVariables?: boolean;
  // Each captured stream is cut here (CapturedOutput.truncated); 1 MiB when absent.
  readonly maximumOutputBytes?: number;
};

// What a process printed on one stream, cut at the runner's limit. `truncated` says it was cut.
export type CapturedOutput = { readonly bytes: Uint8Array; readonly truncated: boolean };

// How a stopped command's container went. removed: it is gone, so the command ended with it.
// removal-failed: the engine could not remove it, or did not say it had, within the bounded wait.
// command-never-settled: the container is gone but the engine never said the command ended.
export const WorkloadStop = {
  Removed: 'removed',
  RemovalFailed: 'removal-failed',
  CommandNeverSettled: 'command-never-settled',
} as const;
export type WorkloadStop = (typeof WorkloadStop)[keyof typeof WorkloadStop];

// Common to every outcome: what the proxy recorded and what the command printed.
type WorkloadRecords = {
  readonly egressEvents: readonly EgressEvent[];
  // True when the proxy's record could not be read back or the proxy could not write all of it, so
  // egressEvents may lack what it decided. Absent otherwise.
  readonly egressRecordUnread?: boolean;
  // Raw: the engine redacts and leak-scans them before anything keeps them.
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
};

// A command that ended by itself has an exit code; one the runner stopped at its timeout has none.
export type WorkloadOutcome = WorkloadRecords &
  ({ readonly kind: 'exited'; readonly exitCode: number } | { readonly kind: 'timed-out'; readonly stop: WorkloadStop });

// Why the workload runner did not run a request. No code of the team's image ran.
//   image-missing: the team's image, or Revisum's own run image, is not on this host. It is never pulled.
//   image-digest-mismatch: the local image has another id than the request pins.
//   egress-unenforceable: the network with no route out, the proxy or the egress probe failed.
//   workload-start-failed: the request is malformed, or the team's container did not start.
export const WorkloadErrorCode = {
  ...ContainerRefusalCode,
  WorkloadStartFailed: 'workload-start-failed',
} as const;
export type WorkloadErrorCode = (typeof WorkloadErrorCode)[keyof typeof WorkloadErrorCode];

// What an earlier container left in the output folder and this host's user could not remove.
export type OutputRemoval = {
  readonly image: string;
  readonly outputDirectory: string;
  // Relative to the output folder.
  readonly paths: readonly string[];
  // Why the host's user could not, for the runner's log.
  readonly hostFailure: string;
};

export interface WorkloadRunner {
  run(request: WorkloadRequest): Promise<Result<WorkloadOutcome, WorkloadErrorCode>>;
  // Tries to remove the paths as the user the image's containers run as, which owns what they made.
  // It promises nothing, since only the host's own look can show they have gone, and a runner with
  // no way to do this does nothing, leaving the host's user as the only one to try.
  removeFromOutput(removal: OutputRemoval): Promise<void>;
}
