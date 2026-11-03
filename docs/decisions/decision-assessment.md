# The founder's rulings on the decision assessment

## In short

- A fresh Opus helper assessed the refactor's decisions on 2026-11-03, with `docs/prompts/session-decision-assessment.md`. The founder ruled on what it raised.
- Grounding the core stays closed until the rulings on network blocks are in: why each block exists, what dropping it would do, what others do, then a plan.
- The review brief is the oracle. Existing code gets fixed; it never justifies removing a requirement.

## Decisions

| Raised | Founder's ruling | What changes |
|---|---|---|
| The parts can tick while "a call that type-checks is a correct call" still fails | Add the part | New part, cleared run: the gate returns one value holding plan, project, target and standing; `baseUrl` is parsed; `act` and `probe` take resolved types, with the secret carried on the fill; the guarantee level is read at seal through a port |
| The order writes code twice and repoints test files twice | Reorder | `START.md` holds the new order. Behaviour bugs and egress come first, and structural findings 8, 14, 22 and 59 travel with their parts |
| No real caller until SPEC-16 | Keep at SPEC-16 | Nothing. No `bin` in this refactor |
| Plan size against M3 and M4 | Keep the full size | Nothing deferred |
| CI has never run on this branch | Push at phase 3's end | Nothing. CI results stay unknown until then |
| A single 502, 503 or 504 in `expectBackend` is at once `Failed`, and declaring 404 lets a plain `call` pass on it | `Errored`, and `pendingStatuses` | 502, 503 and 504 end `Errored`. A new `pendingStatuses` field is used only by the backend check. Stopping on anything else stays |
| Finding 147 carries a `Secret` into stub bytes in the driver | Reveal in `browser-session.ts` | No new `REVEAL_ALLOWED_MODULES` entry |
| The wording of "nothing retries" catches the click loop | Prevent the loop | The founder first chose the assessor's sentence, then asked for wording that prevents the loop. An input is sent once, so a swallowed click fails the step. Finding 154 removes the loop |
| "Deleted test" is `must fix`, but the driver port part has to delete tests | Allow deleting tests | A test may go once what it covers can no longer happen. One whose behaviour can still happen is flagged, because deleting it would loosen the suite |
| Constant-object sweep, about 1,540 sites | Keep the sweep | Nothing. Typed result codes stay open as findings 8 and 22 |
| `no-unnecessary-condition` baseline | Fix the 22 hits | No baseline. The fixes get their own commit |
| The review standard would send reviewers in circles | No requirement removed | "The review is the oracle, don't base removing requirements on the existing code. The existing code should be fixed." Each fix is done on its own, and anything else found goes under the check it belongs to, not into the fix in hand |
| False passes would get past the review standard | Re-run the break test | Added as the last item of grounding the core |

**Open:** Chrome's own traffic and private addresses. The founder rejected flag-by-flag blocking as likely to bring up subtle issues, and asked for the research above on all blocks and related code before ruling. Egress step 2 onwards waits for this.

## Findings

- The main session placed the lint switch, constant objects and foundation helpers ahead of the assessor's order, which didn't name them. The founder can reverse this.
- `START.md`'s order replaces the order in the refactor plan file.

## Risks

- Removing the click loop may turn overlays and animations into `not-actionable` failures. The assessor assumed this and nobody has tested it, so finding 154 measures it, and any new failures go to the founder rather than bringing a retry back.
