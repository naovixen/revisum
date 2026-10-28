# Plan language changelog

Newest entry first. Each entry names the sha256 of `plan.schema.json` as it stood after the change, and `npm run lint` fails when the newest entry does not name the committed schema's hash, so the schema cannot change without an entry here. Regenerate the schema with `node tools/check-plan-schema.ts --write`, which prints the hash to record.

## 1.1 (2026-10-28)

Schema sha256: `906726f3b06796ba6c9a7e8b8745362db90d29893520e61052e92b25ed1036cb`

- First published schema. A plan declares `"version": "1.1"`.
- New steps: `hover`, `select`, `upload` (a file the project declares in `fixtures`), `frame` (steps inside an iframe, nested up to the project's `maximumFrameDepth`) and `dialog`.
- A `fill` value may be a reference `{ "secretName": … }` to a secret the project declares in `secretNames`, instead of literal text.
- New element assertions: `absent` (no element matches; `hidden` also passes for one element that is present but not shown), `checked`, `unchecked`, `focused` and `countEquals`; new page assertion `url`.
- New roles: `listbox`, `menuitem`, `table`, `row`, `cell` and `form`. New keys: `Delete`, `Home`, `End`, `PageUp` and `PageDown`.
- Every `expect` and `expectPage` step carries a `criterionId`: the acceptance criterion it checks. A plan with no assertion, an empty assertion or an assertion without a `criterionId` is rejected as `vacuous`.
- Version 1 plans are accepted for 12 months, only through `migratePlan`, which takes a criterion id for each assertion keyed by its JSON path and fails with `no_criterion_id` for any assertion left out.
- Until the browser drivers support them, runs report `hover`, `select`, `upload`, `frame` and `dialog` steps, secret references and the `checked`, `unchecked` and `focused` assertions as failed with `unsupported-step`.

## 1 (seeded)

- The seeded language: `navigate`, `click`, `fill`, `press`, `expect`, `expectPage`, `a11yAudit` and `capture`. No schema was published.
