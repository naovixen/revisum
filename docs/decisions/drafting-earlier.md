# Drafting moves to M2, and a live-page draft route is added

## In short

- The founder asked (2026-10-29) whether AI should drive the browser instead of typed plans. The answer kept: **AI drafts once, the engine replays with no inference.** AI at run time would make the verifier as non-deterministic as the software it checks, and live-agent testing is already cheap and crowded.
- The gap was the way in. Plans come only from hand-writing until M4, and route c needs written acceptance criteria, which many teams building with AI don't have.
- The founder approved two changes: move SPEC-28's `draft` from M4 to M2, and add SPEC-37, `revisum draft --explore <url>`, which drafts from a deterministic crawl of the running app.

## Decisions

| Decision | Why | Confidence |
|---|---|---|
| Keep the engine model-free; AI only drafts, and every draft meets `admitDraft`, the parser, the gate and a person | Independent, replayable evidence is the product (`E:\core\docs\08-ai-horizon.md` risk 2; `01`, automation levels) | high |
| SPEC-28 `draft` moves to M2, right after SPEC-35's workload runner, with the planner adapters | A demo should start with "it drafted my tests" rather than learning the plan format; the founder builds to demo, then judges | high |
| Add SPEC-37: a crawl that only navigates and reads, a redacted page map, the AI drafts text, and a static locator check | Gives a draft without written criteria, while the AI never touches the browser | medium |
| Planner adapters speak Anthropic Messages and OpenAI-compatible chat completions over `fetch`, with no SDK | Covers the customer's own key and local models (Ollama, LM Studio) with no new dependency | high |
| SPEC-16's other commands stay in M4; `draft` is wired into `cli` early | Only drafting was asked to move | high |

## Findings

- `PLAN_SOURCES`, `AiPlanner` and `admitDraft` already exist in `contracts` and `engine`. The CDP driver already reads the full accessibility tree. Proposal runs (SPEC-02) already let a person try an unapproved draft on non-production origins.
- The built `AiPlanner.propose` takes a `SpecInput`. SPEC-28's `DraftRequest` replaces it when route c is built.

## Risks

- **Prompt injection through page text.** A page can tell the planner to add steps. Mitigation: page text is quoted data, the draft only gets as far as the parser, gate and a person, and AC-SPEC-37-12 proves hostile lines are refused.
- **Drafts encode today's bugs.** A draft from the live page checks what the page does, not what it should do. Mitigation: a fixed notice in every explored draft, and `--from <spec.md>` when criteria exist.
- **Page text leaving the machine.** The page map goes to the customer's chosen endpoint. Mitigation: non-production origins only, roles and names only, no values, redaction, and the exact request kept beside the draft. SPEC-09's PII pass replaces the pattern redaction in M3.
- **M2 grows.** Two more items before the alpha. The velocity kill criteria are on M1 (done) and M3 (2027-06-07), so neither is affected.
