# SPEC-17: Release artefacts and claim rules

## Purpose

Turn a verified run into the release material teams write by hand, and keep every word core publishes defensible. It serves "release notes and store screenshots eat a day every release" (UP-12, a hypothesis) and "we can't prove what was tested, against which spec, or by whom" (UP-08): notes, stills and an evidence pack from the run, with no compliance or replacement claims.

## Scope and non-goals

- **In:** a changelog from Conventional Commits with a "verified on" table; a deterministic release-note draft (the core skeleton's `releaseNoteDraft`, spike P3); a release evidence pack (manifest, hashes, artefacts, audit excerpt, readiness summary: required targets, open P1/P2, undecided review items); AI wording only as a stored suggestion; a `marketing` render target for stills that requires a `demo` or `permission` flag and labels fixture runs; a claim lint over docs, report templates and stills.
- **Non-goals:** ACR or accessibility statement drafts (SPEC-26); a release decision (stays human).

## Interfaces and types

```ts
export type ReadinessSummary = {
  readonly requiredTargetsPassed: boolean; readonly openBySeverity: Readonly<Record<Severity, number>>;
  readonly undecidedReviewItems: number; readonly recommendation: 'ready' | 'not-ready' | 'needs-decision'; // advice only
};
export type EvidencePack = { manifestHash: string; resultHash: string; chainHead: string; artefacts: readonly ArtifactReference[]; readiness: ReadinessSummary };
export type StillRequest = { runId: string; size: '1280x800' | '2560x1600'; flag: 'demo' | 'permission' };
export const FORBIDDEN_CLAIMS: readonly RegExp[]; // compliant, unhackable, replaces testers, all devices, Safari supported (until the Mac run)
```

## Acceptance criteria

- AC-SPEC-17-01: When the changelog is built from a fixture history, it shall match the golden file and list the targets each change was verified on (oracle: regression).
- AC-SPEC-17-02: When an AI suggestion exists for release text, it shall be stored beside the deterministic draft and shall not replace it until an approval that can gate (SPEC-02) exists for its hash (oracle: specified).
- AC-SPEC-17-03: When the readiness summary is computed, any open P1 or P2 or failed required target shall make the recommendation `not-ready` (oracle: specified).
- AC-SPEC-17-04: When a still is requested for a run without a `demo` or `permission` flag, rendering shall be refused; fixture-run stills shall carry a visible fixture label (oracle: specified).
- AC-SPEC-17-05: When the claim lint runs over docs, report templates and stills' captions, any match of `FORBIDDEN_CLAIMS` outside a marked "may not say" example shall fail the build (oracle: specified).
- AC-SPEC-17-06: When the only approval for a release-text suggestion's hash is the maintainer's declared approval under agent lock-down, it shall be enough for the suggestion to replace the draft, and the evidence pack shall show that approval as "declared, not verified" (oracle: specified).

## Dependencies

- SPEC-11, SPEC-12, SPEC-14 (chain head for the evidence pack). The core skeleton's AI-text module and `releaseNoteDraft` (spike P3 `ai.ts`); the report renderer's stills (P6).
- Research background: API and integration (`05` Finding 7); moat, modules and go-to-market (`07` Finding 8); interface (`11` Finding 4). FTC order on compliance claims [C-R03-047]; no study of unedited release notes [C-R06-035].

## Milestone

M4 for the marketing render target and claim lint (FR-24, NFR-10); phase 2a for the changelog, release-note draft and evidence pack (FR-23), budgeted in the research effort model (`calc/f2_effort.mjs`, research repo).

## Satisfies

FR-23, FR-24, NFR-10
