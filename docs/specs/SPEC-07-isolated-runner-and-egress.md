# SPEC-07: Isolated runner and egress control

## Purpose

Bound the blast radius of a harmful but valid plan or a hostile page. It serves "letting AI agents into our pipeline feels like handing over the keys" (UP-09): a run has no ambient credentials and can reach only declared origins.

## Scope and non-goals

- **In:** a non-root container with a seccomp profile, pinned by image digest; an allow-list egress proxy outside the browser covering page, WebSocket, worker, popup, redirect and beacon traffic; a resolve-time IP check against private, loopback, link-local and metadata addresses; no cloud, production or publishing credentials in the run environment; the run's `guaranteeLevel` set to `isolated` only when egress is enforced; a hook for the ladder's browser mutants (SPEC-21): response rewriting on fixture origins.
- **Non-goals:** microVM isolation (hosted only, SPEC-24); network isolation for the optional Playwright `host` mode.

## Interfaces and types

```ts
export type ServiceName = Brand<string, 'ServiceName'>;   // a non-browser service declared in the trusted project
export type ImageDigest = Brand<string, 'ImageDigest'>;   // container image digest, "sha256:<hex>"
export type RunnerHandle = { readonly runId: string; egressEvents(): readonly EgressEvent[]; stop(): Promise<void> };
export type EgressPolicy = {
  readonly allowOrigins: readonly Origin[];       // from the trusted project
  readonly allowServices: readonly ServiceName[];  // http steps go through the same proxy
  readonly denyPrivateRanges: true;
};
export type EgressEvent = { origin: Origin; channel: 'page' | 'websocket' | 'worker' | 'popup' | 'redirect' | 'beacon'; decision: 'allowed' | 'blocked' };
export interface Runner {
  start(image: ImageDigest, policy: EgressPolicy): Promise<Result<RunnerHandle, RunnerError>>;
  guaranteeLevel(): GuaranteeLevel;                // 'isolated' only when egress is enforced, else 'host'
}
```

### Build notes (alignment, 2026-10-29)

The seeded `contracts` code wins where it differs from the block above: `ServiceName` and `ImageDigest` already exist, `RunnerError` already lists `image-missing`, `image-digest-mismatch`, `egress-unenforceable` and `start-failed`, and `GuaranteeLevel` is `'isolated' | 'host'`. Marked additions are new with this spec. Where tests run is set by `docs/decisions/container-tests.md`.

- **Run image** (the research names only the pinned base image and separately pinned browsers).
  - `runner/image/Dockerfile` builds the run image `FROM` the base image pinned by digest (the one in `.devcontainer/devcontainer.json`). It installs Chromium's system libraries and nothing else. Browsers are not baked in: `.browsers/` is mounted read-only, and their builds are pinned by SPEC-05's lockfile.
  - `prepareRunImage()` (addition) builds it with the Docker CLI and records the built image's id (`sha256:…`) and the Dockerfile's hash in `.revisum-run-image.json`, which Git ignores. A changed Dockerfile or base digest means a rebuild.
  - `start(image, policy)` compares `image` with the local image's id. A missing image gives `image-missing`, a different id `image-digest-mismatch`, and nothing starts (AC-06).
  - The manifest records the base digest, the Dockerfile hash and the built id. Publishing the image to a registry waits for beta and the founder.
- **Docker** is driven through its CLI with `spawn`, never a shell; no new dependency. A `ContainerEngine` port (addition) lets unit tests use a fake.
- **Network layout.** Each run creates a Docker network with `--internal`, so it has no route out. The run container joins only that network. A proxy container, from the same run image and running `runner`'s proxy module, joins both that network and the default bridge. Chromium gets `--proxy-server`, and service calls use the same proxy. A request that bypasses the proxy has nowhere to go. The run removes its containers and network when it stops.
- **Container hardening** (AC-03, AC-04): `--user node`; `--security-opt seccomp=.devcontainer/seccomp-chrome-sandbox.json`; `--cap-drop ALL`; `--security-opt no-new-privileges`; `--read-only` with a private `/tmp`. The environment is built from an empty allow-list, with nothing inherited from the host. Only what the run needs is mounted, read-only: `packages`, `node_modules`, `.browsers`, and the run's inputs. That excludes `.git`, the home folder and any credential file.
- **Proxy** (`runner`, in-process capable, so AC-01, AC-02 and AC-07 run in `npm run check` with a real Chromium and no container).
  - It allows only the policy's origins and services. A blocked request gets a 403 for plain HTTP, or a refused `CONNECT` for HTTPS, and is recorded.
  - It records `{ origin, decision }`. Over HTTPS it sees only the host and port, so the channel comes from the browser.
- **The proxy's own answers** (addition, 2026-10-30, with SPEC-32's real caller). The proxy marks its own refusals (403, 400) with `x-egress-decision: blocked`, and its failures to connect (502) with `unreachable`. It strips that header from every service response, so a service can't forge it. The caller maps the marks to `egress-blocked` and `service-unreachable`, and returns the service's own statuses as received.
- **Channels** (AC-01). The CDP driver already sees each request's type through the `Network` domain, with auto-attach to workers and popups. It records each request's origin and channel: `websocket` for `Network.webSocketCreated`, `beacon` for type `Ping`, `redirect` for a request with a `redirectResponse`, `worker` and `popup` for requests from those targets, and `page` otherwise.
  - The run joins the browser's records with the proxy's decisions by origin, in order, to make `EgressEvent`s.
  - A decision the browser never reported gets the channel `unattributed` (addition), never a guess.
- **Resolve-time check** (AC-02). The proxy resolves each name itself, refuses if any resolved address is in a refused range, then connects to that vetted address without a second lookup, which defeats DNS rebinding.
  - Refused ranges, unless declared as a private service: IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, and 224/4 and above.
  - Refused IPv6: `::`, `::1`, fc00::/7, fe80::/10, fec0::/10, ff00::/8, and IPv4-mapped, IPv4-compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses whose embedded IPv4 is refused.
  - Refused metadata addresses: 169.254.169.254, fd00:ec2::254 and 100.100.100.200.
  - Names that resolve to a refused address, such as `127.0.0.1.nip.io`, are refused by their resolved address. Tests use a fake resolver, never the network.
- **Guarantee level** (AC-05). `guaranteeLevel()` is `isolated` only after the internal network, the proxy and the run container have all started and a probe from inside the container to an undeclared address has failed. Otherwise it is `host`, the run logs `egress-unenforceable`, and the result's guarantee carries the loss reason `egress-unenforceable` (already in `contracts`), so no report claims hermetic isolation.
- **Browser mutants** (AC-07): `EgressPolicy.responseRewrites?` (addition), a list of `{ origin, rewrite }`. The proxy applies a rewrite only to plain-HTTP responses from declared fixture origins, refuses any other origin when the policy is built, and the manifest records each rewrite applied.
- **Running a plan in the container.** `RunnerHandle` gains `exec(argv)` (addition), which runs a command inside the run container without a shell. The container tests use it to inspect the user, seccomp mode, environment and files, and to run a plan through a test-set script. The `run` command's wiring is SPEC-16's.

### Review fixes (M2 exit, 2026-11-01)

A cold review at the M2 exit found that a real container run's evidence could be wrong or missing while the tests still passed. These are marked additions, tests first as usual. None loosens a refusal.

- **Applied rewrites reach the manifest (AC-07).** The container proxy writes each applied rewrite to a file beside its decisions. `RunnerHandle` gains `rewritesApplied(): readonly AppliedRewrite[]`, so a mutated container run's manifest differs from a plain run's.
- **Joining records and decisions (AC-01).** `joinEgressEvents(records, decisions, directOrigins = [])`. A browser record with no decision of its own is, in this order:
  - `blocked` if its channel is `popup`, which the driver holds back before it loads;
  - given the latest decision for the same host and port, since one tunnel carries many requests;
  - `allowed` if its origin is in `directOrigins`, the declared origins the run knows the browser sends past the proxy (loopback);
  - otherwise `blocked`. The fallback can over-report a block, but never claims an unseen request was allowed.
- **Channels in a real container (AC-01).** `RunnerHandle` gains `proxyDecisions(): readonly ProxyDecision[]`, and `egressEvents(records = [], directOrigins = [])` takes the browser's records, printed by the process inside the container. A container test asserts a WebSocket's channel, not only its origin and decision.
- **Evidence survives a failed read (AC-01).** A non-zero read of the proxy's files keeps the decisions already read, except when the file does not exist yet, which still reads as no lines.
- **The result's claim follows the runner (AC-05).** `RunInputs.guaranteeLevel?: GuaranteeLevel`, default `host`, set by whoever started the run from `Runner.guaranteeLevel()`. Only `isolated` makes `run` state `egressEnforced: true`; the default keeps committed hashes as they are. A test observes the real result, both ways.
- **Rewrite policy (AC-07).** The policy builder refuses a fixture origin that is undeclared or not plain HTTP. `startProxyServer`, which both the in-process and the container proxy use, refuses to start with a rewrite whose origin is undeclared or not plain HTTP, so a hand-built policy can't widen it. `EgressPolicy` stays unbranded, because committed tests build it directly; the builder alone knows which origins are fixtures.
- **Coverage (AC-01, AC-02).** New tests, with counter-examples:
  - a popup to a reachable host leaves that host's server with no request;
  - a private service never reaches a metadata address;
  - an allowed `CONNECT` succeeds, a refused one is recorded as blocked, and a rebinding name is refused for tunnels too;
  - direct connections from the run container try metadata and the Docker gateway.
- **More IPv6 forms refused (AC-02).** Also refused: IPv4-translated `::ffff:0:0/96`, local NAT64 `64:ff9b:1::/48` and Teredo `2001::/32`.
- **Smaller fixes.**
  - The `.git` mount check ignores case, since Windows does.
  - A refused malformed request (400) is recorded as a blocked decision.
  - A stopped Docker daemon gives `start-failed`, not `image-missing`.
  - `runner`'s product name comes from `PRODUCT`. `readImageDigest` stays the listed owner of its cast.
- **No gateway to the Docker host (AC-04, AC-05).** Found with these tests: on an `--internal` network the run container could still reach a service on the Docker host through the network's gateway, so `isolated` overclaimed. Internal networks are now created with `-o com.docker.network.bridge.inhibit_ipv4=true`, which removes the gateway and leaves peers connected. The isolation probe also tries where the gateway would be, so a Docker that keeps the gateway gives `host`, not `isolated`. The run and workload networks share one `createNetwork`.
- **The probe, as built.** Docker 29 gives a network with no gateway's first container the subnet's first address. So the probe skips that address when a container on the network holds it. Otherwise it tries port 80 and counts a refused connection as reached, since a kept gateway refuses unused ports. A network it cannot read, or whose IPv4 subnet it cannot find, counts as reached.
- **Replay's claim matches replay (AC-05).** `replay-identical` follows the run's isolation, so a plan run at the `isolated` level that calls declared services without a recording would claim it while `replayManifest` refuses it. Such a run loses `replay-identical`, with the new loss reason `replies-not-recorded`. A run with a recording keeps it.
- **Replaying an isolated run.** The manifest doesn't record the level. `guaranteeLevel` is one of a replay's `inputs`, so an isolated run replayed without it gives `mismatch`, or `per-environment-baseline` on another machine: never a pass.
- **Left as they are.** The `as TargetId` casts and the two template strings in committed tests stay: no behaviour depends on them, and they are committed tests. `Runner` wiring for plan runs stays SPEC-16's.

## Acceptance criteria

- AC-SPEC-07-01: When a fixture page opens a WebSocket, starts a worker, opens a popup, follows a redirect or sends a beacon to an undeclared origin, the proxy shall block each and record an `EgressEvent` (oracle: specified).
- AC-SPEC-07-02: When a URL resolves to a private, loopback, link-local or metadata address not declared as a private service, the request shall be refused at resolve time, including for DNS names and IPv6 forms (oracle: specified; extends AC-p7-09).
- AC-SPEC-07-03: When the run environment is inspected from inside the container, no cloud, production or publishing credential shall be readable (oracle: specified).
- AC-SPEC-07-04: When the container starts, its process shall run as a non-root user with the pinned seccomp profile (oracle: specified).
- AC-SPEC-07-05: When egress cannot be enforced on a CI provider, the run shall report `guaranteeLevel: 'host'` and log `egress-unenforceable`, and the report shall not claim hermetic isolation (oracle: specified; the MVP plan's "Isolation" kill criterion, research `09`).
- AC-SPEC-07-06: When the pinned image is missing or its digest differs, `start` shall return `image-missing` or `image-digest-mismatch` and no browser shall launch (oracle: specified).
- AC-SPEC-07-07: When a browser mutant is configured (SPEC-21), the proxy shall apply it only to declared fixture origins and record it in the manifest (oracle: specified).

## Dependencies

- SPEC-06, SPEC-27. The API-step spike's network guard (P7 `netguard.ts`).
- Research background: architecture (`04` Findings 1 and 7). Capability-style runtimes start with no ambient authority [C-R13-043].

## Milestone

M2.

## Satisfies

NFR-03
