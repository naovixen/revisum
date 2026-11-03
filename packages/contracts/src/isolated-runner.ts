// The isolated runner's port: a run starts in a container pinned by image digest, behind an egress
// proxy that lets traffic reach only the origins and services the trusted project declares.
// The types live here so the runner, the drivers and the engine agree on them without importing
// one another.
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
// held: the driver held a popup back before it loaded, and nothing refused its origin.
export type EgressDecision = 'allowed' | 'blocked' | 'held';
// What a proxy can decide. Only a browser's driver holds anything back.
export type ProxyVerdict = Exclude<EgressDecision, 'held'>;

// An origin as it was seen on the wire, not as a project declared it, so it is plain text:
// "scheme://host[:port]", or "host:port" for a tunnel whose scheme the proxy cannot see.
export type SeenOrigin = string;

// A request the browser reported, by its origin and channel. `undeclared` marks a popup whose origin
// the run may not reach, which only the driver can say, since the proxy never sees a held popup.
export type BrowserRequestRecord = { readonly origin: SeenOrigin; readonly channel: BrowserChannel; readonly undeclared?: true };
// What the egress proxy decided for one request, by origin. Over HTTPS it sees only the host and port.
export type ProxyDecision = { readonly origin: SeenOrigin; readonly decision: ProxyVerdict };
// One request that tried to leave the run, with the channel the browser saw and the proxy's decision.
export type EgressEvent = { readonly origin: SeenOrigin; readonly channel: EgressChannel; readonly decision: EgressDecision };

// A browser mutant's change to a response body: every occurrence of `find` becomes `replace`.
// `name` identifies the mutant in the run manifest.
export type ResponseRewrite = { readonly name: string; readonly find: string; readonly replace: string };
// A rewrite and the fixture origin whose plain-HTTP responses it applies to.
export type FixtureRewrite = { readonly origin: Origin; readonly rewrite: ResponseRewrite };
// A rewrite the proxy actually applied, by origin and mutant name, for the run manifest.
export type AppliedRewrite = { readonly origin: SeenOrigin; readonly name: string };

// What a run may reach. The runner's policy builder refuses a fixture origin that is undeclared or
// not plain HTTP, and a rewrite on any origin but a fixture origin. Only the builder knows which
// origins are fixtures. The type is not branded, so the egress proxy also refuses, when it starts,
// a rewrite whose origin is undeclared or not plain HTTP.
export type EgressPolicy = {
  // The trusted project's origins.
  readonly allowOrigins: readonly Origin[];
  // Declared services; their calls go through the same proxy.
  readonly allowServices: readonly ServiceName[];
  // Declared services a database command reaches over plain TCP, each at its one declared port.
  // The proxy relays that port to the service's address and nothing else; empty for every other run.
  readonly allowTcpServices: readonly ServiceName[];
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
  // Every request the proxy decided on so far, as egress events. Only a process inside the run
  // container sees what the browser reported, so whoever runs it hands those records in. They give
  // each event its channel; with none, every decision is unattributed. `directOrigins` are the
  // declared origins the run knows the browser sends past the proxy, such as its own loopback.
  egressEvents(records?: readonly BrowserRequestRecord[], directOrigins?: readonly SeenOrigin[]): readonly EgressEvent[];
  // Every decision read back from the proxy so far, in the order made. They outlive the run's containers.
  proxyDecisions(): readonly ProxyDecision[];
  // Each browser mutant's rewrite the proxy applied so far, read back from it, for the run manifest.
  rewritesApplied(): readonly AppliedRewrite[];
  // Runs an argument vector inside the run container, without a shell. Each variable named in
  // `environmentNames` is copied into the command's environment from the container client's own,
  // by name only, so a secret is never on a command line.
  exec(command: readonly string[], environmentNames?: readonly string[]): Promise<ExecOutcome>;
  // Removes the run's containers and network.
  stop(): Promise<void>;
  // 'isolated' only while egress is shown to be enforced for this run, else 'host'. It falls to 'host'
  // when the proxy's record proves incomplete, which is known only after exec or stop, so a starter
  // must read it again then before it claims anything for the run.
  guaranteeLevel(): GuaranteeLevel;
}

export interface Runner {
  start(image: ImageDigest, policy: EgressPolicy): Promise<Result<RunnerHandle, RunnerError>>;
  // The level of the latest run this runner started, or 'host' before it has one. A runner may hold
  // several runs at once, so what a run claims for itself comes from its own handle.
  guaranteeLevel(): GuaranteeLevel;
}
