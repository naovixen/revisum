# Glossary

## In short

- Each domain term, the name it has in code, and where that name lives. Use these names; add a row when you add a term.
- "Planned" means the spec named in the row introduces the code name; it does not exist yet.
- Older names from the research are listed only so readers of the specs can map them. Never use them in code.

## Domain terms

| Term | Code name | Where | Meaning |
|---|---|---|---|
| Product name | `PRODUCT` (`PRODUCT.name`, `PRODUCT.schemaNamespace`) | `contracts`, exists | The only place the product name is written; schema ids are built from it |
| Engine | `engine` package | `packages/engine` | The trusted core: parsing, trust, policy, lifecycle, interpreter, oracle, hashing, redaction, audit log |
| Package | npm workspace | `packages/*` | One unit of the monorepo, with its own licence and allowed imports |
| Plan | `Plan`, made only by `planParser`; `assertBranded` checks it at run time | type in `contracts`, parser in `engine`, exists | A human-approved, typed test plan in language version 1.1; outside input until the engine parses it |
| Step | `Step`, `ActionStep` | `contracts`, exists | One instruction in a plan, from a closed set: navigate, click, hover, fill, select, upload, press, frame, dialog, expect, expectPage, a11yAudit, capture |
| Plan migration | `migratePlan`, `CriterionMapping` | `engine`, exists | Turns a version 1 plan into version 1.1 by adding the criterion id the author gives for each assertion, keyed by its JSON path |
| Plan schema | `planJsonSchema`, `docs/plan-language/plan.schema.json` | `engine`, exists | The published JSON Schema of the plan language, built from the parser's own tables; necessary, not sufficient |
| Secret reference | `SecretReference` (`SecretName`) | `contracts`, exists | A fill value that names a secret the project declares, instead of holding it |
| Upload fixture | `FixtureName` | `contracts`, exists | A file the project declares in its `fixtures` list, which an upload step may send. Not the app files a run serves (`FixtureReference`) |
| AI text | `AiText`, made only by `parseAiText` | `engine`, exists | Text an AI writer returned that passed the text rules; stored only as a suggestion |
| Coverage study | `assessCoverage`, `tools/coverage-study.ts` | `engine`, exists | Sampled test intents from public suites, each marked expressible in the plan language or not, with the expressible share |
| Locator | `Locator` | `contracts`, exists | How a step finds an element: by role and name, label, text or test id. Never CSS or XPath |
| Project | `Project`, made only by `parseProject` | `engine`, exists | The trusted, person-written configuration: allowed origins, the target matrix, limits, and the secret names and fixture files plans may refer to |
| Target | `Target` (`TargetId`) | `contracts`, exists | One declared browser engine, device profile, locale and environment to test with. Never substituted |
| Browser driver | `BrowserDriver`, `Session` | ports in `contracts`; `cdpDriver` in `driver-cdp`, `playwrightDriver` in `driver-playwright` | Opens a session for a target; a session navigates, acts, probes, captures and audits |
| Run | `run`, `runUntrusted`, `RunResult` | `engine`, exists | Interprets a parsed plan on one target and returns a hashed result |
| Run lifecycle | `lifecycle` (`Planned`, `Resolved`, `Running`, terminal states) | `engine`, exists | The typed state machine every run walks; illegal transitions do not compile |
| Run manifest | `RunManifest`, `manifestHash` | `engine`, exists | Every input that decides a run's result, hashed, so the run can be replayed. See SPEC-08 |
| Logging manifest | `LOGGING_MANIFEST`, `manifestLogger`, `RunEventSink` | `engine`, exists | The only fields a run may log, with why and for how long; the sink a run's events go to. Not the audit `EventSink` of SPEC-27 |
| Redaction | `Redactor`, `defaultRedactor`, `SENSITIVE_PLACEHOLDER` | port in `contracts`, default in `engine`, exists | Masks personal-data elements in screenshots and personal-data patterns in kept text |
| Accessibility finding | `A11yFinding` (driver audit), `Finding` (own engine) | `contracts`, `auditor-act`, exist | One accessibility problem: a rule, its WCAG criteria, severity and the element's box |
| ACT rule, probe | `RuleMeta` with `kind: 'act-rule' \| 'probe'` | `auditor-act`, exists | A check that follows a W3C ACT rule, or a WCAG success criterion where no ACT rule exists |
| Tab walk | `tabWalk`, `TabWalk` | `auditor-act`, exists | Presses Tab through a page and records focus order, visible focus and occlusion |
| Report input | `ReportInput`, `ValidReport`, made only by `parseReportInput` | `report`, exists | The data a visual evidence report is rendered from |
| Seed provenance | `seed-provenance.json` (`SeedProvenance` shape) | repository root, exists | Where each seeded file came from: research commit, source path and SHA-256. The only file that names the research commit |
| Acceptance criterion | `criterion` (`criterionId`, `CriterionId`, `criteriaInScope`) | test metadata; on every plan assertion, exists | One observable behaviour a spec promises. Earlier name: AC |
| Change class | `changeClass` (`changeClassId`) | planned | The kind of change a pull request makes, which sets how much review it needs |
| Test set | `TEST_SET` | `tools/check-tests-apart.ts`, exists | Tests, proofs, fixtures and golden files: the paths that must change apart from code |
| Dependency review | `DependencyReview` with `DependencyCheck` items | planned, SPEC-00 | The keep-or-drop test every third-party component on the trust path must pass. Earlier name: R11 test |
| Naming lint | `NamingLintConfig`, `NAMING_LINT`, `lintRepository` | `tools/`, exists | Enforces the naming rules in CI |
| Declared approval | `declared` | planned, SPEC-02 | An approval resting on the founder's own push or merge under the agent lock-down |
| Verified approval | `verified` | planned, SPEC-02 | An optional approval by a second account; never required |
| Actor | `DerivedActor` (`ActorId`, `ActorType`), `PERSON_ACTOR_TYPES` | types in `contracts`, built only in `engine/src/actor.ts`, exists | Who an audit event is recorded against, derived by core and never declared by the caller. A person is any actor type in `PERSON_ACTOR_TYPES`; declared and verified count alike |
| Audit event sink | `EventSink`, `jsonLinesEventSink`, `EventInput`, `AuditEventKind` | port in `contracts`, sink in `engine`, exists | Append-only JSON Lines audit log; refuses to append once anything else truncated or rewrote the file. SPEC-14 adds the hash chain |
| Error code | closed unions such as `PlanErrorCode`, `DriverErrorCode`, `CliErrorCode` | `contracts` and `engine`, exists; anchors in `docs/errors.md` | A machine-readable reason from a closed set; each has a `## <code>` heading, so `errors#<code>` resolves |
| Guarantee level | `GuaranteeLevel` (`isolated`, `host`) | `contracts`, exists | How strongly a run is isolated; `host` claims no egress enforcement and no replay |
| Run history, thresholds | `RunRecord`, `Thresholds`, `ThresholdMetric` | `contracts`, exists | Finished runs as metrics see them, and the levels the maturity ladder needs |

## Metrics

| Term | Code name | Earlier name |
|---|---|---|
| Share of criteria traced to a passing test | `tracedCriteriaShare` | T |
| Share of runs that were flaky | `flakyRunRate` | F |
| Share of results verified without human review | `verifiedWithoutReviewShare` | V |
| Share of commits authored by an agent | `agentAuthoredShare` | A |
| Share of commits linked to a spec | `specLinkedShare` | S |
| Share of mutants the tests caught | `mutantsCaughtShare` | M |
| Plan approvals per change | `planApprovalsPerChange` | P |
| Share of merges without review | `unreviewedMergeShare` | U |
| Defects that escaped to users | `escapedDefects` | E |

All are planned (SPEC-00 and SPEC-15).

## Standard names

These acronyms may appear in code. Each is always the full name below.

| Acronym | Full name |
|---|---|
| ai | artificial intelligence |
| mcp | Model Context Protocol |
| sarif | Static Analysis Results Interchange Format |
| junit | JUnit XML test-report format |
| oidc | OpenID Connect |
| jwt | JSON Web Token |
| lti | Learning Tools Interoperability |

## Allowed abbreviations

id, url, uri, html, css, json, http, api, cli, ci, pr, cdp (Chrome DevTools Protocol), bidi (WebDriver BiDi), wcag (Web Content Accessibility Guidelines), act (Accessibility Conformance Testing rules), a11y (accessibility), pii (personally identifiable information), sha256, svg, png, dom, os.
