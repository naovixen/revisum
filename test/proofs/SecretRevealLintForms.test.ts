// Three more ways a module could reach reveal: as a member of an awaited dynamic import, by a
// bracketed read of a namespace, and by destructuring in the callback of a dynamic import's then.
// The same shapes taking something else, or taking reveal from something that is no import, pass.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../tools/RunRepositoryRules.ts";
import { assertLintFails, assertLintPasses } from "./scratch-edits.ts";
import { copyRepository, type ScratchRepository } from "./scratch-repository.ts";

const TIMEOUT = 300_000;
const ONLY_THE_RULE = { rule: RepositoryRuleName.SecretReveal };
const PLANTED_FILE = "planted-secret-peek.ts";
const PLANTED_MODULE = `packages/cli/src/${PLANTED_FILE}`;
const ALLOWED_MODULE = "packages/driver-cdp/src/session/TextToFill.ts";

type PlantedSource = { readonly how: string; readonly source: string };

const WAYS_TO_REACH_REVEAL: readonly PlantedSource[] = [
    {
        how: "reads reveal off an awaited dynamic import",
        source: "export const peek = (await import('@revisum/contracts')).reveal;\n",
    },
    {
        how: "reads reveal off an awaited dynamic import of a computed specifier",
        source: [
            "const contractsPackage = '@revisum/contracts';",
            "export const peek = (await import(contractsPackage)).reveal;",
            "",
        ].join("\n"),
    },
    {
        how: "reads a namespace import's reveal in brackets",
        source: [
            "import * as contracts from '@revisum/contracts';",
            "export const peek = contracts['reveal'];",
            "",
        ].join("\n"),
    },
    {
        how: "reads a dynamically imported namespace's reveal in brackets",
        source: [
            "const contracts = await import('@revisum/contracts');",
            'export const peek = contracts["reveal"];',
            "",
        ].join("\n"),
    },
    {
        how: "destructures reveal in the callback of a dynamic import's then",
        source: "export const peek = import('@revisum/contracts').then(({ reveal }) => reveal);\n",
    },
    {
        how: "destructures reveal under another name in the callback of a dynamic import's then",
        source: "export const peek = import('@revisum/contracts').then(({ reveal: show }) => show);\n",
    },
];

const SAME_SHAPES_THAT_NEVER_REACH_REVEAL: readonly PlantedSource[] = [
    {
        how: "reads another export off an awaited dynamic import",
        source: "export const passed = (await import('@revisum/contracts')).success;\n",
    },
    {
        how: "reads a namespace import's other export in brackets",
        source: [
            "import * as contracts from '@revisum/contracts';",
            "export const passed = contracts['success'];",
            "",
        ].join("\n"),
    },
    {
        how: "destructures another export in the callback of a dynamic import's then",
        source: "export const passed = import('@revisum/contracts').then(({ success }) => success);\n",
    },
    {
        how: "names its own local reveal after destructuring another export",
        source: "export const passed = import('@revisum/contracts').then(({ success: reveal }) => reveal);\n",
    },
    {
        how: "reads a property called reveal off its own object in brackets",
        source: [
            "const panel = { reveal: true };",
            "export const isOpen = panel['reveal'];",
            "",
        ].join("\n"),
    },
    {
        how: "destructures reveal from a promise that is no import",
        source: [
            "declare function loadPanel(): Promise<{ readonly reveal: boolean }>;",
            "export const isOpen = loadPanel().then(({ reveal }) => reveal);",
            "",
        ].join("\n"),
    },
];

describe("Using the secret reveal lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given a module outside the allow-list", () => {
        for (const { how, source } of WAYS_TO_REACH_REVEAL) {
            describe(`when it ${how}`, () => {
                test("then it should fail, naming the module", { timeout: TIMEOUT }, () => {
                    assertLintFails(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE), [
                        "secret reveal check: ",
                        PLANTED_FILE,
                    ]);
                });
            });
        }

        for (const { how, source } of SAME_SHAPES_THAT_NEVER_REACH_REVEAL) {
            describe(`when it ${how}`, () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    assertLintPasses(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE));
                });
            });
        }
    });

    describe("given a module on the allow-list", () => {
        describe("when it reaches reveal each of these ways", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                const outcome = scratch.lintWithEdit(
                    ALLOWED_MODULE,
                    (text) =>
                        [
                            text.trimEnd(),
                            "",
                            "import * as contractsAgain from '@revisum/contracts';",
                            "export const revealOffImport = (await import('@revisum/contracts')).reveal;",
                            "export const revealInBrackets = contractsAgain['reveal'];",
                            "export const revealInThen = import('@revisum/contracts').then(({ reveal }) => reveal);",
                            "",
                        ].join("\n"),
                    ONLY_THE_RULE,
                );
                assertLintPasses(outcome);
            });
        });
    });
});
