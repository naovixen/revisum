// A module specifier written as a template literal loads the module just as a quoted one does, so
// each import rule must read it. A template holding an allowed module, or a library's name kept as
// data, passes.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import { assertLintFails, assertLintPasses } from "../support/WithEdits.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const ONLY_RUNTIME_IMPORTS = { rule: RepositoryRuleName.RuntimeImports };
const ONLY_IMPORTS = { rule: RepositoryRuleName.Imports };
const RUNTIME_SET_FILE = "planted-template-import.ts";
const RUNTIME_SET_MODULE = `packages/report/src/${RUNTIME_SET_FILE}`;
const TRUSTED_FILE = "planted-template-import.ts";
const ENGINE_MODULE = `packages/engine/src/${TRUSTED_FILE}`;
const CONTRACTS_MODULE = `packages/contracts/src/${TRUSTED_FILE}`;
const ROUTE_FILE = "DraftCommand.ts";
const ROUTE_MODULE = `packages/cli/src/commands/${ROUTE_FILE}`;

type PlantedSource = { readonly how: string; readonly source: string };

const withLinesFirst =
    (...lines: readonly string[]) =>
    (text: string): string =>
        `${lines.join("\n")}\n${text}`;

const BANNED_LIBRARY_LOADS: readonly PlantedSource[] = [
    {
        how: "dynamically imports a banned library",
        source: "export const load = () => import(`puppeteer`);\n",
    },
    {
        how: "dynamically imports a sub-path of a banned library",
        source: "export const load = () => import(`playwright-core/lib/server`);\n",
    },
    {
        how: "requires a banned library",
        source: [
            "declare function require(specifier: string): unknown;",
            "export const load = () => require(`puppeteer`);",
            "",
        ].join("\n"),
    },
];

const ALLOWED_RUNTIME_TEMPLATES: readonly PlantedSource[] = [
    {
        how: "dynamically imports a Node built-in",
        source: "export const load = () => import(`node:fs`);\n",
    },
    {
        how: "dynamically imports a local file through a substitution",
        source: "export const load = (name: string) => import(`./${name}.ts`);\n",
    },
    {
        how: "keeps a banned library's name as data",
        source: "export const library = `puppeteer`;\n",
    },
];

describe("Using the runtime import lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given a package in the runtime set", () => {
        for (const { how, source } of BANNED_LIBRARY_LOADS) {
            describe(`when it ${how} with a template literal`, () => {
                test("then it should fail, naming the module", { timeout: TIMEOUT }, () => {
                    assertLintFails(
                        scratch.lintWith(RUNTIME_SET_MODULE, source, ONLY_RUNTIME_IMPORTS),
                        ["runtime import check: ", RUNTIME_SET_FILE],
                    );
                });
            });
        }

        for (const { how, source } of ALLOWED_RUNTIME_TEMPLATES) {
            describe(`when it ${how} with a template literal`, () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    assertLintPasses(
                        scratch.lintWith(RUNTIME_SET_MODULE, source, ONLY_RUNTIME_IMPORTS),
                    );
                });
            });
        }
    });
});

describe("Using the import lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given route code", () => {
        describe("when it dynamically imports the engine whole with a template literal", () => {
            test("then it should fail, naming the route module", { timeout: TIMEOUT }, () => {
                const outcome = scratch.lintWithEdit(
                    ROUTE_MODULE,
                    withLinesFirst("export const loadEngine = () => import(`@revisum/engine`);"),
                    ONLY_IMPORTS,
                );
                assertLintFails(outcome, ["import check: ", ROUTE_FILE, "@revisum/engine"]);
            });
        });

        describe("when it dynamically imports a Node built-in with a template literal", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                const outcome = scratch.lintWithEdit(
                    ROUTE_MODULE,
                    withLinesFirst("export const loadFiles = () => import(`node:fs`);"),
                    ONLY_IMPORTS,
                );
                assertLintPasses(outcome);
            });
        });
    });

    describe("given the engine", () => {
        describe("when it dynamically imports a third-party package with a template literal", () => {
            test(
                "then it should fail, naming the module and the package",
                { timeout: TIMEOUT },
                () => {
                    const outcome = scratch.lintWith(
                        ENGINE_MODULE,
                        "export const load = () => import(`left-pad`);\n",
                        ONLY_IMPORTS,
                    );
                    assertLintFails(outcome, ["import check: ", TRUSTED_FILE, "left-pad"]);
                },
            );
        });

        describe("when it requires a third-party package with a template literal", () => {
            test(
                "then it should fail, naming the module and the package",
                { timeout: TIMEOUT },
                () => {
                    const outcome = scratch.lintWith(
                        ENGINE_MODULE,
                        [
                            "declare function require(specifier: string): unknown;",
                            "export const load = () => require(`left-pad`);",
                            "",
                        ].join("\n"),
                        ONLY_IMPORTS,
                    );
                    assertLintFails(outcome, ["import check: ", TRUSTED_FILE, "left-pad"]);
                },
            );
        });

        describe("when it dynamically imports what it may with template literals", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                const outcome = scratch.lintWith(
                    ENGINE_MODULE,
                    [
                        "export const loadFiles = () => import(`node:fs`);",
                        "export const loadContracts = () => import(`@revisum/contracts`);",
                        "export const loadBrand = () => import(`./foundation/Brand.ts`);",
                        "",
                    ].join("\n"),
                    ONLY_IMPORTS,
                );
                assertLintPasses(outcome);
            });
        });
    });

    describe("given contracts", () => {
        describe("when it dynamically imports the engine with a template literal", () => {
            test(
                "then it should fail, naming the module and the package",
                { timeout: TIMEOUT },
                () => {
                    const outcome = scratch.lintWith(
                        CONTRACTS_MODULE,
                        "export const load = () => import(`@revisum/engine`);\n",
                        ONLY_IMPORTS,
                    );
                    assertLintFails(outcome, ["import check: ", TRUSTED_FILE, "@revisum/engine"]);
                },
            );
        });
    });
});
