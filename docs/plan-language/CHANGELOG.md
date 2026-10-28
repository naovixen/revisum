# Plan language changelog

Newest entry first. Each entry names the sha256 of `plan.schema.json` as it stood after the change, and `npm run lint` fails when the newest entry does not name the committed schema's hash, so the schema cannot change without an entry here. Regenerate the schema with `node tools/check-plan-schema.ts --write`, which prints the hash to record.

## 1.1 (2026-10-28, secrets)

Schema sha256: `a8de4ce560a15ff02b1e6eaec657d2e4465efa825a956a5b8ef33bb15e07e6bc`

- Still `"version": "1.1"`: the change only adds an optional field, so every plan that parsed before still parses the same way, except plans holding a literal secret (below).
- New optional top-level field `storageState: { "secretName": … }`: saved browser storage state (cookies and local storage), named like any secret the project declares in `secretNames`. The secret's value is the storage-state JSON. The run records only its name and sha256; loading it into the browser session comes with the driver's session environment.
- New plan error `literal_secret`: literal text filled into a field whose locator names a password, passcode, token, secret or API key (also in German and French), credential-shaped text anywhere in the plan (a JSON Web Token, `Bearer …`, or a known key prefix such as `ghp_`, `sk-` or `AKIA`), or storage state written into the plan itself.
- Secret references in `fill` now run: the browser drivers type the resolved secret. A run whose plan names a secret the store cannot resolve is refused with `secret-missing` before any browser opens.

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
