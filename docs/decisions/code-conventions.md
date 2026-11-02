# Code conventions

## In short

- A convention is kept only if it is current practice and applies to this project. Each kept rule lives where it fits best: layout in Prettier, code rules and names in ESLint, editor behaviour in `.editorconfig` and WebStorm, and anything no tool can check in `.claude/rules/`, which loads by path.
- Existing code is baselined in `eslint-suppressions.json`, so new violations fail at once. The refactor is finished when that file is empty and deleted.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Files | PascalCase after the main export, no type suffix; related exports may share a file; folders kebab-case; `index.ts` lowercase | Readable and searchable. One export per file would split about 1,250 types and interfaces, adding files and imports to read |
| Test files | `PlanParser.test.ts`, `PlanParser.Errors.test.ts` | The tools and `check:containers` already use `.test.ts` |
| File size | `max-lines` 400, not counting blanks and comments | With exports sharing files, this keeps each one cheap to read. Not from the conventions; a judgement to revisit |
| Interfaces | No `I` prefix | TypeScript's guidelines and Google's guide both advise against it |
| Privates | `#private` | The JavaScript standard, and enforced at run time; TypeScript's `private` is checked only at compile time |
| Fixed sets of values | Constant objects with `as const` and a type of the same name, never magic strings (founder, 2026-11-02) | Node runs the `.ts` files with no build step and errors on `enum` without an experimental flag. The objects read like enums and give one place to find each value, and their string values still match the JSON plans and results |
| Function style | `function` for hoisted declarations and anything relying on `this` or `arguments`; method shorthand for object methods; `class` for constructors; arrow functions elsewhere (founder, 2026-11-02) | Each form is used where it fits. ESLint enforces arrows for callbacks only, because the rest is a judgement call. Existing code isn't mass-converted |
| Shorthand | `{ name }` required | The old ban assumed no type safety; TypeScript catches those renames |
| Constants | `UPPER_CASE` allowed on top-level `const` | The repository's style, about 1,500 uses, and allowed by Google's guide |
| Records | Bracket access allowed on index signatures | Decoders read unverified keys from `Record<string, unknown>` that way on purpose |
| Boolean names | `is`, `has`, `can`, `should`, `was`, `did` on variables and parameters | The rule can't read a function's return type, so functions are in `.claude/rules/typescript.md` |
| Field names | Object and type properties aren't name-checked | Results, plan schemas, events and CDP calls have published or external names |
| Quoted keys | `quoteProps: preserve` | Some quoted keys are deliberate (`tools/check-seed-provenance.ts`) |
| Mixed operators | Left to Prettier, which adds the parentheses | `no-mixed-operators` is deprecated in ESLint |

**Rules that stay as Revisum already had them:** `unknown` at boundaries until a decoder parses it, generics such as `<Value>` not `<T>`, the abbreviation list in `CLAUDE.md`, and tests in `test/` rather than beside the code. The `{ criterion }` test tag and spec citations in comments were dropped on 2026-11-02: tests read standalone, and traceability lives in `Criteria:` commit trailers.

**Left out because the reasoning has expired:** initialising `let` for browser optimisation, grouping `const` before `let`, no generators, symbol polyfills, IIFEs, hoisting tutorials, bundler loader syntax, and CSS preprocessor nesting.

**Left out because they don't apply here:** component frameworks and component testing (none in the code or design); test libraries, HTTP helpers and model stores this repository doesn't use; review by a second person, which conflicts with never gating on one; versioning and changelog rules, which `docs/specs/SPEC-17-release-artefacts-and-claims.md` owns; a package CSS prefix and utility classes, because the report is one standalone document; a custom deep-immutable type, because `readonly` is already used throughout; README owners and API tables, because `index.ts` is the list; import group order, because there are almost no default imports; and a unit and integration split, because the test folders define it.

## Findings

- ESLint marks `curly`, `no-else-return` and others as frozen. Frozen means no new features, not deprecated, so they are kept.
- TypeScript 7's package has no compiler API. `ts-api-utils` accepts any TypeScript version, so in a shared install npm hoists it to the root, where it loads TypeScript 7 and crashes. `tools/eslint/` therefore has its own lock file, and a root `postinstall` installs it.
- A full typed lint takes about 30 seconds.
- ESLint's Node API can apply suppressions but its docs don't mention editors, so WebStorm may show baselined violations too.

## Risks

Hazards for the refactor:

- **Test titles:** `tools/guarantee-map.ts`, `tools/dependency-reviews.ts` and `docs/guarantees.md` reference tests as `file#title`. Retitling or moving a test means updating them.
- **File paths:** named in `seed-provenance.json` (`to`), `package.json` scripts, CI workflows, `CODEOWNERS`, `docs/specs/`, `docs/system-design.md` and `docs/glossary.md`.
- **Page functions:** the `in-page` functions are sent with `.toString()` (`packages/driver-cdp/src/cdp-driver.ts:578`). They must stay self-contained when long functions are broken up.
- **Source-reading tests:** some tests read source text. After the double-quote reformat, `/from 'node:os'/` in `test/unit/report/report-generator.test.ts` would keep passing while proving nothing, so it must match both quote styles. `test/proofs/page-script-driver-dependencies.test.ts` and `test/proofs/service-call-isolation.test.ts` have the same quote assumption but fail loudly.
- **Naming lint:** check that `tools/lint-names.ts` accepts PascalCase file names before renaming.
- **Suppressions are keyed by path:** a renamed file loses its baseline, so it must be clean or re-suppressed in the same commit. Wrapping lines can also push a function over a size limit, so regenerate the size rules' entries with the reformat.
- **Windows:** case-only renames (`run.ts` to `Run.ts`) need care.
- **Scale:** about 3,000 `curly` violations (autofixable), 2,700 test titles, 530 file names and 250 truthy checks (not autofixable).
- **`type` to `interface`:** existing `type`s stay `type`, because interfaces aren't assignable to index signatures.
- **Second TypeScript:** remove `typescript` 6 and the separate install once typescript-eslint supports 7.
- **Release compile step, not part of this work:** packages export `./src/index.ts`, but Node refuses to run TypeScript from `node_modules`. `docs/system-design.md` already says packages publish compiled JS, so that step is still to come.
