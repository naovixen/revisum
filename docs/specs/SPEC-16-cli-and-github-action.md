# SPEC-16: CLI and GitHub Action

## Purpose

Put core where teams already work, and let their agents drive it (AI-drivable, R9). It serves "manual regression before every release holds the release up" (UP-05): every pull request gets a verified run without anyone clicking through a browser.

## Scope and non-goals

- **In:** a CLI with JSON I/O: `validate`, `lock`, `run`, `export`, `review`, `approve` and `doctor`, plus `convert` (M1) and `draft` (M2, moved from M4 on 2026-10-29; `--explore` from SPEC-37) from SPEC-28; `validate` and `run` accept plans in JSON or readable text, each through `admitDraft`, with errors by line and column for text; `draft` writes an unapproved readable draft from a spec's acceptance criteria through the `AiPlanner` port on the customer's own key or a local model, and never runs or approves it; `approve` and `review` sign with a registered key where the optional signed route is set up (SPEC-02), or record `unverified`; typed errors from the shared `CliErrorCode` union (SPEC-27) with doc links; `doctor` diagnosing common setup faults (missing secret, undeclared origin, unpinned target, egress blocked, token scope); a GitHub Action wrapping the CLI that uploads SARIF and artefacts and posts the PR comment; npm release with provenance and an SBOM; dependencies pinned by hash with lifecycle scripts off.
- **Non-goals:** other CI vendors' native plug-ins (JUnit covers them); MCP (SPEC-18); hosted runs.

## Interfaces and types

```ts
export type Command = 'validate' | 'lock' | 'run' | 'export' | 'review' | 'approve' | 'doctor' | 'convert' | 'draft';
// core draft --from <spec.md> [--criteria AC-1,AC-3] --out plans/<name>.plan   (PlannerEndpoint from project config)
// core convert <file> --to json|text
export type CliOutput<Data> = { schema: `${string}.cli/v1`; command: Command; ok: boolean; data?: Data; errors?: readonly CliError[] };
export type CliError = { code: CliErrorCode; path?: string; docs: `errors#${CliErrorCode}` };
export type DoctorCheck = { id: 'secret-missing' | 'origin-undeclared' | 'target-unpinned' | 'egress-blocked' | 'token-scope'; status: 'ok' | 'fail'; fix: string };
```

```yaml
# action.yml (shape)
inputs: { project: { default: project.json }, plans: { default: 'plans/**/*.{json,plan}' }, comment: { default: 'true' } }
runs: { using: node24, main: dist/action.js }
```

## Acceptance criteria

- AC-SPEC-16-01: When each command runs with `--json`, its output shall validate against the CLI schema, and golden transcripts shall match (oracle: regression).
- AC-SPEC-16-02: When `doctor` runs against each seeded misconfiguration, it shall report the matching check as `fail` with a fix (oracle: specified).
- AC-SPEC-16-03: When the Action runs on the demo application in a public repository, it shall upload SARIF and artefacts and post one PR comment (oracle: specified).
- AC-SPEC-16-04: When the npm package is published, its provenance shall verify and an SBOM shall be attached (oracle: specified).
- AC-SPEC-16-05: When dependencies are installed in CI, lifecycle scripts shall be disabled and every dependency pinned by hash (oracle: specified).
- AC-SPEC-16-06: When the run finishes, the exit code shall follow `ExitCode` and `EXIT_PRECEDENCE` in SPEC-11 (oracle: specified).
- AC-SPEC-16-07: When `approve` runs with a registered, user-present key on the optional signed route, it shall emit a signature SPEC-02 verifies. With no registered key, it shall record the approval `unverified`, say that it can't gate, and name the routes that can: a code-owner review, or a maintainer's merge under agent lock-down (oracle: specified).
- AC-SPEC-16-08: When any command fails, its JSON output shall carry a `CliErrorCode` and a docs link that resolves; an unknown command or flag shall return `usage` (oracle: specified).
- AC-SPEC-16-09: When `draft` runs with `--json`, its output shall carry the draft path, `PlanSource` `draft-command`, the errors by line and `approved: false`; no run, approval or trusted-file write shall follow from the command (oracle: specified; golden transcript with a recorded planner response).
- AC-SPEC-16-10: When `convert` runs on each golden plan in either form, the output shall equal the stored golden file of the other form (oracle: regression).

## Dependencies

- SPEC-02 (`approve`), SPEC-05 (`lock`), SPEC-28 (`draft`, `convert`, `admitDraft`), SPEC-11, SPEC-12, SPEC-13 (`review`), SPEC-27 (error codes).
- Research background: API and integration (`05` Finding 4); moat, modules and go-to-market (`07` Finding 8). Short-lived CI tokens [C-R09-022].

## Milestone

M4 (public beta at its exit); `convert` ships with the readable format at M1 (SPEC-28).

## Satisfies

FR-21, FR-22, FR-46, NFR-09
