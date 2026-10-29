# runner

The isolated runner. A run starts in hardened containers from the run image (`image/Dockerfile`, built by `prepareRunImage` and pinned by its id), on a Docker network with no route out, behind the egress proxy that allows only declared origins and services and checks every resolved address.

- `startEgressProxy` runs the proxy in-process; `proxy-container.ts` runs it as a proxy container's main process.
- `dockerRunner` starts a run through a `ContainerEngine`: `dockerCliEngine` drives the Docker client with `spawn`, never a shell; unit tests pass a fake.
- `npm run check:containers` runs the real-container tests (see `docs/decisions/container-tests.md`).

It may import only `contracts` and Node built-ins. Licence: FSL-1.1-ALv2.
