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
