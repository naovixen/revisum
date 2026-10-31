# Recordings of service and command replies are opt-in

## In short

- Replaying a run that calls declared services or runs database commands (SPEC-08, with AC-SPEC-32-13 and AC-SPEC-36-15) needs the original replies: response bodies and command output.
- Secrets are cut out of a recording, but personal data would stay in it until SPEC-09's masking (M3), and result folders can end up as CI artefacts.
- The founder chose (2026-10-31): **recording is opt-in.** A project turns it on in the trusted `project.json`; without it, such runs are not replay-claimed.

## Decisions

| Decision | Why | Confidence |
|---|---|---|
| `replay: { recordReplies: true }` in the trusted project turns recordings on; off by default | Nothing that may hold personal data is written unless a project asks for it | high |
| Without it, a run with calls or commands is refused for replay with `replay-not-claimed` | A replay never sends live calls or runs commands, so without replies it cannot be claimed identical | high |
| Recordings are written beside the result as `<run id>.recording.json`, and no exporter, report or PR comment reads them | Keeps them out of everything shared | high |
| SPEC-09 masks recordings with the same PII pass as other evidence | One masking rule for all evidence | medium |

## Findings

- The result keeps only hashes of replies, so replay cannot work from the result alone.
- The other options were always recording (personal data at rest until M3) and moving the two criteria after SPEC-09 (M2 would exit without them).

## Risks

- A project that turns recording on before SPEC-09 keeps personal data in its result folder. The setting's documentation must say so.
- If SPEC-09's masking changes reply bytes the engine reads, masked recordings may no longer replay identically; SPEC-09 must mask only what the engine never reads, or keep an unmasked local copy.
