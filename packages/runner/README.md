# runner

The isolated runner. A run starts in hardened containers from the run image (`image/Dockerfile`, built by `prepareRunImage` and pinned by its id), on a Docker network with no route out, behind the egress proxy that allows only declared origins and services and checks every resolved address.

- `startEgressProxy` runs the proxy in-process; `proxy-container.ts` runs it as a proxy container's main process.
- `serviceCaller` sends a declared service call through the proxy, once, never following a redirect and reading no more than the size cap. The proxy marks its own refusals and failures with an `x-egress-decision` header, so the caller reports them as `egress-blocked` or `service-unreachable`, not as the service's status.
- `dockerRunner` starts a run through a `ContainerEngine`: `dockerCliEngine` drives the Docker client with `spawn`, never a shell; unit tests pass a fake.
- `workloadRunner` runs a team's own image behind the same proxy. For a database command, the proxy relays the one TCP port of the service the policy allows over TCP (`allowTcpServices`) to that service's checked address, and the team's container maps the service's name to the proxy (`--add-host`), so the command connects by name and reaches nothing else.
- `npm run check:containers` runs the real-container tests (see `docs/decisions/container-tests.md`).

It may import only `contracts` and Node built-ins. Licence: FSL-1.1-ALv2.
