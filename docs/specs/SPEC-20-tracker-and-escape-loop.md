# SPEC-20: Tracker connector and escape loop

## Purpose

Bring escaped defects into core, so every escape becomes a regression check and Levels 4 and 5 rest on escape data (low and falling escapes, RC-01; a regression check per escape, RC-03). It serves "we can't tell whether AI work gets through with less human checking, or just ships more defects" (UP-11): whether AI-built changes escape more, measured.

## Scope and non-goals

- **In:** a read-only connector for one issue tracker (first chosen by partner demand); escapes by severity, labels, timestamps for time waiting for testing (RC-06) and support-ticket links where labelled (support tickets from testing gaps, RC-22); severity and label changes copied into the audit log; reading a ticket's "Acceptance criteria" or "Testing considerations" section for the ticket drafting route (SPEC-28, GitHub Issues first), with read-only scopes; a proposed regression plan per escape, closed only when its check fails before the fix and passes after (no repeat incidents, RC-03 and RC-26).
- **Non-goals:** writing to the tracker; drafting or approving plans in the connector (drafts go through SPEC-28's `admitDraft`); root-cause analysis (stays human, AI may propose); incident-tool and CD integrations (later).

## Interfaces and types

```ts
export interface TrackerPort { escapes(since: string): Promise<readonly EscapeRecord[]> } // read-only
export type EscapeRecord = { issueId: string; severity: Severity; labels: readonly string[]; createdAt: string; readyForTestAt?: string; linkedSupportTickets: number; commit?: string };
// Ticket drafting route (SPEC-28): one configured section of an issue body, as plain text for extractCriteria.
export type CriteriaSections = readonly string[];   // headings to read, default ["Acceptance criteria", "Testing considerations"]
export type RegressionLoop = { issueId: string; planHash: string; failsBeforeFix: boolean | null; passesAfterFix: boolean | null; state: 'proposed' | 'approved' | 'closed' };
```

## Acceptance criteria

- AC-SPEC-20-01: When the connector reads a fixture tracker export, escapes by severity and test wait per change shall equal a hand count (oracle: specified).
- AC-SPEC-20-02: When a severity or label changes in the tracker, an audit event shall record the old and new values (oracle: specified).
- AC-SPEC-20-03: When an escape is linked to a fix commit, the loop shall stay open until its approved check fails on the parent commit and passes on the fix (oracle: specified).
- AC-SPEC-20-04: When the connector holds credentials, they shall be read-only scopes, and any write call shall be absent from the code (oracle: specified).
- AC-SPEC-20-05: When a fixture issue is read for drafting, only the text under a configured heading shall be passed on, an issue without one shall return `no-criteria-section`, and the call shall use read-only scopes (oracle: specified).

## Dependencies

- SPEC-14; SPEC-02 for plan approval; SPEC-28 for the ticket drafting route.
- Research background: maturity and roles (`10` Findings 4 and 5). ISTQB's escaped-defect definition [C-R15-038].

## Milestone

Phase 2a.

## Satisfies

FR-28, FR-29, FR-47
