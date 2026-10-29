# Chrome keeps its sandbox in containers

Founder decision, 2026-10-28.

## In short

- In the dev container and in CI, Chrome runs with its own sandbox on, as the image's `node` user.
- Its sandbox needs user, PID and network namespaces, which Docker's default seccomp profile allows only with full admin rights (`CAP_SYS_ADMIN`). `.devcontainer/seccomp-chrome-sandbox.json` is Docker's default profile plus those namespace calls.
- Both `npm run check:linux` and the CI `ci` job use that profile.

## Decisions

| Option | Decision | Why |
|---|---|---|
| A narrow profile: Docker's default plus `clone` with namespace flags, `unshare` and `setns` | **Chosen** | Chrome keeps its sandbox and the container stays filtered. SPEC-07 already plans a pinned seccomp profile for runs |
| Turn the filter off (`seccomp=unconfined`) | Rejected | Lifts every syscall restriction from the container |
| Launch Chrome with `--no-sandbox` | Rejected | Revisum will load untrusted pages; Chrome's sandbox is a layer of defence against them |

- CI starts the pinned image with `docker run` after checkout instead of as a job container, because a job container starts before the profile file exists on the runner.
- Setup (`npm ci`, the browsers' system libraries) runs as root; the browsers and `npm run check` run as `node`, because Chrome refuses to sandbox as root.

- **Addition, founder decision 2026-10-29:** the Chrome rule also allows `chroot`. SPEC-07's run container drops every capability, and Docker's default allows `chroot` only with `CAP_SYS_CHROOT`, so Chrome's sandbox stopped at `sys_chroot`. The kernel still checks that capability, which Chrome holds only inside its own new user namespace, so the container gains nothing on the host. Rejected instead: `--cap-add SYS_CHROOT` (breaks AC-SPEC-07-04's empty capability set) and `--no-sandbox`.

## Findings

- With Docker's default profile, Chrome stops at start-up with "No usable sandbox!", and 14 of 82 tests failed on the Linux image.
- With the narrow profile, `npm run check:linux` passes: 82 tests, 23 proofs and the golden replay. The CI step, run locally on a copy of the repository, also passes.
- As root, Chrome refuses to start without `--no-sandbox`, whatever the profile.
- Source: Docker 29.8.2's default profile (`vendor/github.com/moby/profiles/seccomp/default.json` at tag `docker-v29.8.2`, SHA-256 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`). The change removes the two rules that allow `clone` only without namespace flags, and adds one rule allowing `clone`, `setns` and `unshare` (and, since 2026-10-29, `chroot`). `clone3` still returns "not implemented", so the C library falls back to `clone`.

## Risks

- **Namespace creation is open to everything in the container**, not only Chrome. Mitigation: the container holds no credentials and runs as `node`, and the change is limited to the three calls.
- **The profile can drift from Docker's default.** When Docker Desktop or the CI runner's Docker changes a major version, regenerate the profile from that version's default and repeat the change above.
