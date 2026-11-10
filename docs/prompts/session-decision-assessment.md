# Brief: independent assessment of the refactor's decisions

The founder requires this once, before grounding the core starts (2026-11-03). Grounding doesn't start until the founder has read the report and ruled on what it raises.

The main session gives everything below the line, as its whole brief, to a fresh Opus helper agent. It adds no summary, opinion or reasoning of its own. It reports what the helper finds to the founder, disagreements first, and doesn't settle them itself.

---

Assess the decisions behind this refactor as an independent reader. You have no stake in them, and nobody is expecting you to agree. Treat every stated reason as a claim to check against the code, the tests and, where it matters, current documentation. Reach your own view of each decision before giving weight to the reasons written down for it.

**Read:**

- `CLAUDE.md` and `START.md`, for the goals and the constraints: a solo founder, minimum spend, and code that's maintainable without AI.
- `C:\Users\naomi\.claude\plans\before-starting-on-the-jiggly-squirrel.md`, the refactor plan, especially the target architecture and how the core is grounded.
- `docs/prompts/session-core-review.md`, the standard each part must meet.
- `docs/decisions/refactor-defects.md`, `docs/decisions/host-egress-proxy.md` and `docs/decisions/refactor-baseline.md`.
- The code itself, starting from `packages/engine/src/run.ts`, `packages/contracts/src/browser-driver.ts` and `packages/driver-cdp/src/cdp-driver.ts`.

**Assess:**

1. **The core refactor.** Will the planned parts, in the planned order, deliver the goal in the brief: a call that type-checks is a correct call, and a caller needs nothing of its own to make the core behave? Is anything missing, unnecessary, or in the wrong order? Is the size justified against getting to M3 and M4?
2. **Decisions already made,** in the defect log, `START.md` and the design records, including host runs going through the egress proxy, what counts as a retry, the verdict for backend outages, and declared origins reaching private addresses. Which would you reverse, and which rest on something unproven?
3. **The review standard.** Would it catch what matters, and would it block good code or send reviewers round in circles? Check its rules against what the code actually does.
4. **What nobody asked.** Any risk or simpler route that the plan doesn't consider.

**Report** in at most 60 lines, most consequential first. For each point: the decision, `agree`, `disagree` or `unproven`, your evidence with file and line, what goes wrong if it stands, and what you'd do instead. Say what you checked and what you only assumed. Don't list every decision you agree with: a short line saying which you checked and found sound is enough. Decisions marked as the founder's are open to challenge too, but give the evidence plainly and leave the decision to them.

Change no files and don't commit. Don't start other agents.
