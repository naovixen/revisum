---
paths:
  - "packages/**/*.ts"
  - "tools/**/*.ts"
  - "test/**/*.ts"
---

# TypeScript rules no tool can check

Prettier owns layout and ESLint owns code rules. Run `npm run lint:code` before finishing; its messages say what to change. Code that predates these rules is baselined in `eslint-suppressions.json`: never add to that file to pass a check.

## Files

- Name the file in PascalCase after its main export, with no type suffix: `PlanParser.ts` for `PlanParser`, `EvaluatePolicy.ts` for `evaluatePolicy`. Folders are kebab-case. `index.ts` stays lowercase.
- The main export is the one callers come for. Its helper types may share the file; a second independent concept gets its own file.
- `index.ts` exports only what other packages may use.

## Names

- Reveal intent: say why it exists and what it does. If a name needs a comment, rename it.
- Be honest: include side effects in the name, or split the function.
- Use one word per concept, from `docs/glossary.md`. Use the domain's language over technical jargon.
- Match the level of abstraction: conceptual names high up, concrete names low down.
- Add context only where it's missing: `addressState`, not `state`; `postcode`, not `postcodeString`.
- Name abstractions after their role, and only once concrete cases exist. If no clear single name fits, split it.
- Functions returning a boolean start with `is`, `has`, `can` or `should`. Event handlers start with `on`, in the present tense.
- Don't rename field names in results, plan schemas, events or CDP calls: they are published or external, and renaming breaks golden hashes.

## Functions and data

- Use `function` where it fits: named declarations that benefit from hoisting, and anything relying on its own `this` or `arguments`. In-page functions always need it, because they run with `this` set to the document.
- Use method shorthand for object methods, and `class` for constructors and classes.
- Use arrow functions elsewhere: callbacks, small local functions, and functions assigned to a declared function type.
- Write pure functions by default. Mutate an argument only when the name says so and performance needs it.
- Return an object for multiple values, not an array.
- Destructure only when using many properties; otherwise use property access.
- Prefer non-mutating forms: spread, `toSorted`, `structuredClone`. Mark shared data `readonly`.
- Prefer composition to inheritance. Type a singleton as its interface.

## In-page functions

- A function that runs in the page is sent as its source text, so it can't use anything from its module: no imports, constants, helpers or other in-page functions. Pass values in as arguments.
- Declare it at the top level of an in-page file: one listed in `IN_PAGE_FILES` in `tools/eslint/eslint.config.js`. Keep Node code out of those files; add a new in-page file to the list.
- Send it only by `name.toString()` or as a `PageFunction` argument, which is how the in-page rule recognises it.

## Fixed sets of values

No magic strings. Real `enum`s can't run under Node's type stripping, so a fixed set of values is a constant object with a type of the same name:

```ts
export const ClipboardAssertionKind = {
    TextEquals: "textEquals",
    TextContains: "textContains",
} as const;

export type ClipboardAssertionKind =
    (typeof ClipboardAssertionKind)[keyof typeof ClipboardAssertionKind];
```

- Shared values go in `contracts`, one file per concept. Values used by one feature stay beside it.
- Get a list with `Object.values(...)`; don't keep a parallel array.
- Literals stay in JSON fixtures and goldens, in-page functions (they can't import anything), `typeof` results, `""`, test titles and log messages.

## Comments

Prefer readable code to comments. Before writing one, try a clearer name or extracting a function. Comment only what the code can't say: why a choice was made, security reasoning, language or browser quirks, and useful `TODO:` or `FIXME:` notes. Never state what the code already says.
