# Development dependencies: TypeScript and Node types

## In short

- `typescript` 7.0.2 and `@types/node` 24.19.2 are pinned as root `devDependencies`. Neither ships in any package, and neither is on the trust path.

## Decisions

| Package | Version | Why | Decision |
|---|---|---|---|
| `typescript` | 7.0.2, exact | `tsc --build` is the required type check and enforces the dependency direction between packages. Licence Apache-2.0 | Keep, development only |
| `@types/node` | 24.19.2, exact | Types for the Node 24 built-ins the packages and tools use. Licence MIT | Keep, development only |

## Findings

- TypeScript 7 does not reject an import of an unreferenced workspace package when it resolves through `node_modules`. The `paths` entry in `tsconfig.base.json` maps workspace package names to their sources, so such an import fails with TS6307 ("not listed within the file list of project").
- Neither package is loaded at run time: Node 24 strips types itself.

## Risks

- A TypeScript major can change project-reference behaviour. The import check in `tools/check-imports.ts` is a second line for `contracts` and `engine`.

# Development dependencies: Prettier and ESLint

## In short

- Prettier owns layout and ESLint owns code rules. All are exact-pinned development tools: none ships in a package and none is on the trust path.
- ESLint lives in its own workspace, `tools/eslint/`, with a second TypeScript, because typescript-eslint can't use the repository's compiler.

## Decisions

| Package | Version | Why | Decision |
|---|---|---|---|
| `prettier` | 3.9.10, exact, root | Formats and wraps TypeScript to one layout. Licence MIT, no runtime dependencies | Keep, development only |
| `eslint` | 10.14.0, exact, `tools/eslint/` | Enforces the code rules in the editor, `npm run check` and CI. Licence MIT | Keep, development only |
| `typescript-eslint` | 8.72.1, exact, `tools/eslint/` | Parses TypeScript for ESLint and provides the type-aware rules. Licence MIT | Keep, development only |
| `typescript` | 6.0.3, exact, `tools/eslint/` | The compiler API typescript-eslint needs. Used only for linting; `tsc --build` stays on 7.0.2. Licence Apache-2.0 | Keep until typescript-eslint supports 7 |

## Findings

- TypeScript 7's package has no JavaScript compiler API, and typescript-eslint 8.72.1 supports only `>=4.8.4 <6.1.0`.

## Risks

- Lint reads the code with TypeScript 6 while `tsc` uses 7, so a type-aware rule could rarely disagree with the build. `tsc --build` remains the authority.
