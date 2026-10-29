// The isolated runner's port: a run starts in a container pinned by image digest, behind an egress
// proxy that lets traffic reach only the origins and services the trusted project declares.
// The types live here so the runner, the drivers and the engine agree on them without importing
// one another. See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import type { RunnerError } from './error-codes.ts';
import type { ImageDigest } from './evidence-mode.ts';
import type { Result } from './result.ts';
import type { GuaranteeLevel } from './run-ports.ts';
import type { ServiceName } from './service-calls.ts';
import type { Origin } from './target.ts';

// How a page sent a request, as the browser reports it: an ordinary request of the page, a
// WebSocket, a request of a worker, the first load of a popup, a redirect it followed, or a beacon.
export type BrowserChannel = 'page' | 'websocket' | 'worker' | 'popup' | 'redirect' | 'beacon';
// unattributed: the proxy decided on a request the browser never reported, such as a declared
// service call or traffic from inside the container that was not the browser's.
// process: a process in a workload container that ignored the proxy looked up an undeclared name.
// It had no route out, so only the lookup shows the attempt.
export type EgressChannel = BrowserChannel | 'unattributed' | 'process';
export type EgressDecision = 'allowed' | 'blocked';

// An origin as it was seen on the wire, not as a project declared it, so it is plain text:
// "scheme://host[:port]", or "host:port" for a tunnel whose scheme the proxy cannot see.
export type SeenOrigin = string;

// A request the browser reported, by its origin and channel.
export type BrowserRequestRecord = { readonly origin: SeenOrigin; readonly channel: BrowserChannel };
// What the egress proxy decided for one request, by origin. Over HTTPS it sees only the host and port.
export type ProxyDecision = { readonly origin: SeenOrigin; readonly decision: EgressDecision };
// One request that tried to leave the run, with the channel the browser saw and the proxy's decision.
export type EgressEvent = { readonly origin: SeenOrigin; readonly channel: EgressChannel; readonly decision: EgressDecision };

// A browser mutant's change to a response body: every occurrence of `find` becomes `replace`.
// `name` identifies the mutant in the run manifest.
export type ResponseRewrite = { readonly name: string; readonly find: string; readonly replace: string };
// A rewrite and the fixture origin whose plain-HTTP responses it applies to.
export type FixtureRewrite = { readonly origin: Origin; readonly rewrite: ResponseRewrite };
// A rewrite the proxy actually applied, by origin and mutant name, for the run manifest.
export type AppliedRewrite = { readonly origin: SeenOrigin; readonly name: string };

// What a run may reach. Built only by the runner's policy builder, which refuses a rewrite on any
// origin that is not a declared fixture origin.
export type EgressPolicy = {
  // The trusted project's origins.
  readonly allowOrigins: readonly Origin[];
  // Declared services; their calls go through the same proxy.
  readonly allowServices: readonly ServiceName[];
  // Private, loopback, link-local and metadata addresses are refused at resolve time, except for a
  // service declared private, which still never reaches a metadata address.
  readonly denyPrivateRanges: true;
  // Present only when a browser mutant is configured.
  readonly responseRewrites?: readonly FixtureRewrite[];
};

// What a command run inside the run container printed, and how it ended.
export type ExecOutcome = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export interface RunnerHandle {
  readonly runId: string;
  // Every request the proxy decided on so far, as egress events.
  egressEvents(): readonly EgressEvent[];
  // Runs an argument vector inside the run container, without a shell.
  exec(command: readonly string[]): Promise<ExecOutcome>;
  // Removes the run's containers and network.
  stop(): Promise<void>;
}

export interface Runner {
  start(image: ImageDigest, policy: EgressPolicy): Promise<Result<RunnerHandle, RunnerError>>;
  // 'isolated' only while egress is shown to be enforced for the latest run, else 'host'.
  guaranteeLevel(): GuaranteeLevel;
}
