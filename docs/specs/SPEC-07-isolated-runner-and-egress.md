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
