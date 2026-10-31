// The workload runner's port: a team's own image, pinned by digest, runs one argument vector behind
// the same egress proxy and hardening as the isolated runner. Evidence mode runs a team's
// Playwright suite through it. The types live here so cli can join engine and runner without
// either importing the other.
// See docs/specs/SPEC-35-evidence-mode.md and docs/specs/SPEC-07-isolated-runner-and-egress.md.
import type { ImageDigest } from './evidence-mode.ts';
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

export type WorkloadOutcome = {
  readonly exitCode: number;
  // True when the runner stopped the container at the request's timeout.
  readonly timedOut: boolean;
  readonly egressEvents: readonly EgressEvent[];
  // Raw: the engine redacts and leak-scans them before anything keeps them.
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
};

// Why the workload runner did not run a request. No code of the team's image ran.
//   image-missing: the team's image, or Revisum's own run image, is not on this host. It is never pulled.
//   image-digest-mismatch: the local image has another id than the request pins.
//   egress-unenforceable: the network with no route out, the proxy or the egress probe failed.
//   workload-start-failed: the request is malformed, or the team's container did not start.
export type WorkloadErrorCode = 'image-missing' | 'image-digest-mismatch' | 'egress-unenforceable' | 'workload-start-failed';

export interface WorkloadRunner {
  run(request: WorkloadRequest): Promise<Result<WorkloadOutcome, WorkloadErrorCode>>;
}
