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
