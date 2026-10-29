# Real-container tests: on the host and in one CI step

## In short

- SPEC-07's isolation claims (non-root user, seccomp profile, image digest, no credentials inside, egress blocked) can only be shown by starting real containers.
- The test suite runs inside the pinned image, which has no Docker access, both in CI and in the locked dev container.
- The founder chose (2026-10-29) to run the real-container tests as `npm run check:containers`: on the founder's Windows host through Docker Desktop, and in a separate CI step that may use the runner's Docker. The dev container stays locked, with no Docker.

## Decisions

| Decision | Why | Confidence |
|---|---|---|
| Real-container tests live in their own command, `npm run check:containers`, outside `npm run check` | `npm run check` and `check:linux` run where there is no Docker; a test that can't run there would have to be skipped, and checks never skip | high |
| CI runs `check:containers` in its own step with access to the runner's Docker | The isolation kill criterion asks whether egress can be enforced in CI containers, so CI must show it | high |
| The dev container and the main CI test step get no Docker access | Docker access reaches the host; the dev container is locked so that code in it can't push or reach credentials | high |
| Proxy, allow-list and resolve-time address tests stay in `npm run check`, in-process | They need no container, so they run everywhere, including Linux | high |

## Findings

- CI's test step already runs in the pinned image with the Chrome seccomp profile (`.github/workflows/ci.yml`), but without the Docker socket.

## Risks

- The CI step's test code can control the throwaway CI runner, as the job's own shell steps already can. The job's token is read-only (`permissions: contents: read`).
- On the founder's machine, `check:containers` uses Docker Desktop directly. It starts only containers from the pinned image, and removes the containers and networks it creates.
