import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inPageFunctionsAreSelfContained } from "../../../../tools/eslint/InPageFunctionsAreSelfContained.ts";
import { lintWithTypedRule } from "./support/LintWithRule.ts";

const IN_PAGE_FILE = "src/in-page.ts";
const OPTIONS = [{ inPageFiles: [IN_PAGE_FILE] }];

// The files every case's project holds besides the one under lint.
const SUPPORTING_FILES = {
    "src/page-function.ts": "export type PageFunction = (...inputs: never[]) => unknown;\n",
    "src/page-runner.ts":
        'import type { PageFunction } from "./page-function.ts";\nexport const evaluate = (pageFunction: PageFunction): string => String(pageFunction);\nexport const evaluateIfGiven = (pageFunction: PageFunction | undefined): string => String(pageFunction);\n',
    "src/helpers.ts": "export function helper(): number {\n    return process.pid;\n}\n",
    "src/page-methods.ts":
        'export const page = {\n    read(): string | undefined {\n        return process.env["X"];\n    },\n};\n',
};

const IN_PAGE_PROBE =
    "export function probe(element: Element): string {\n    return element.tagName;\n}\n";

const findingsInPage = (source: string): readonly string[] =>
    lintWithTypedRule(
        inPageFunctionsAreSelfContained,
        { ...SUPPORTING_FILES, [IN_PAGE_FILE]: source },
        IN_PAGE_FILE,
        OPTIONS,
    ).map((finding) => finding.messageId);

const findingsOutside = (source: string): readonly string[] =>
    lintWithTypedRule(
        inPageFunctionsAreSelfContained,
        { ...SUPPORTING_FILES, [IN_PAGE_FILE]: IN_PAGE_PROBE, "src/driver.ts": source },
        "src/driver.ts",
        OPTIONS,
    ).map((finding) => finding.messageId);

describe("Using the in-page functions rule", () => {
    describe("given an in-page file", () => {
        describe("when a function reads a module constant", () => {
            test("then it should report the borrowed name", () => {
                const source =
                    "const LIMIT = 3;\nexport function probe(): number {\n    return LIMIT;\n}\n";
                assert.deepEqual(findingsInPage(source), ["borrowedName"]);
            });
        });

        describe("when a function calls an import", () => {
            test("then it should report the borrowed name", () => {
                const source =
                    'import { helper } from "./helpers.ts";\nexport function probe(): number {\n    return helper();\n}\n';
                assert.deepEqual(findingsInPage(source), ["borrowedName"]);
            });
        });

        describe("when a function calls a sibling function", () => {
            test("then it should report the borrowed name", () => {
                const source =
                    "export function sibling(): number {\n    return 1;\n}\nexport function probe(): number {\n    return sibling();\n}\n";
                assert.deepEqual(findingsInPage(source), ["borrowedName"]);
            });
        });

        describe("when a function reads Node's process", () => {
            test("then it should report the borrowed name", () => {
                const source =
                    "export function probe(): string {\n    return process.platform;\n}\n";
                assert.deepEqual(findingsInPage(source), ["borrowedName"]);
            });
        });

        describe("when a function uses browser and JavaScript globals and its own locals", () => {
            test("then it should pass", () => {
                const source = [
                    "export const probe = (element: Element): string => {",
                    "    const label = element.getAttribute('aria-label') ?? undefined;",
                    "    const box = Element.prototype.getBoundingClientRect.call(element);",
                    "    return JSON.stringify({ label, width: Math.round(box.width), title: document.title, url: window.location.href, hasGlobal: globalThis !== undefined });",
                    "};",
                    "",
                ].join("\n");
                assert.deepEqual(findingsInPage(source), []);
            });
        });

        describe("when a function calls itself by its own name", () => {
            test("then it should pass", () => {
                const source =
                    "export function depth(node: Node): number {\n    return node.parentNode === null ? 0 : 1 + depth(node.parentNode);\n}\n";
                assert.deepEqual(findingsInPage(source), []);
            });
        });

        describe("when a function names a module constant only in typeof within a type", () => {
            test("then it should pass", () => {
                const source =
                    "const SHAPE = { width: 1 };\nexport function probe(input: unknown): typeof SHAPE | undefined {\n    return typeof input === 'object' ? (input as typeof SHAPE) : undefined;\n}\nexport const shape = SHAPE;\n";
                assert.deepEqual(findingsInPage(source), []);
            });
        });

        describe("when a function sits inside a top-level object", () => {
            test("then it should report the function as not at the top level", () => {
                const source =
                    'export const page = {\n    read(): string | undefined {\n        return process.env["X"];\n    },\n};\n';
                assert.deepEqual(findingsInPage(source), ["functionInObject"]);
            });
        });
    });

    describe("given a file that is not in-page", () => {
        describe("when it sends a local function by toString", () => {
            test("then it should report the function as sent from elsewhere", () => {
                const source =
                    "function local(): number {\n    return 1;\n}\nexport const source = local.toString();\n";
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });
        });

        describe("when it passes an inline arrow as a page function", () => {
            test("then it should report the function as written in place", () => {
                const source =
                    'import { evaluate } from "./page-runner.ts";\nexport const title = evaluate(() => document.title);\n';
                assert.deepEqual(findingsOutside(source), ["writtenInPlace"]);
            });
        });

        describe("when it passes a function imported from a file that is not in-page", () => {
            test("then it should report the function as sent from elsewhere", () => {
                const source =
                    'import { evaluate } from "./page-runner.ts";\nimport { helper } from "./helpers.ts";\nexport const result = evaluate(helper);\n';
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });
        });

        describe("when it sends a function imported from an in-page file", () => {
            test("then it should pass, by toString and as a page function", () => {
                const source =
                    'import { evaluate } from "./page-runner.ts";\nimport { probe } from "./in-page.ts";\nexport const result = evaluate(probe);\nexport const source = probe.toString();\n';
                assert.deepEqual(findingsOutside(source), []);
            });
        });

        describe("when it sends a parameter", () => {
            test("then it should pass, by toString and as a page function", () => {
                const source =
                    'import type { PageFunction } from "./page-function.ts";\nimport { evaluate } from "./page-runner.ts";\nexport const send = (pageFunction: PageFunction): string => evaluate(pageFunction) + pageFunction.toString();\n';
                assert.deepEqual(findingsOutside(source), []);
            });
        });

        describe("when it sends a field typed as a page function", () => {
            test("then it should pass, by toString and as a page function", () => {
                const source =
                    'import type { PageFunction } from "./page-function.ts";\nimport { evaluate } from "./page-runner.ts";\ntype Holder = { readonly read: PageFunction };\nexport const send = (holder: Holder): string => evaluate(holder.read) + holder.read.toString();\n';
                assert.deepEqual(findingsOutside(source), []);
            });
        });

        describe("when it passes a page function along to another that sends it", () => {
            test("then it should pass", () => {
                const source =
                    'import type { PageFunction } from "./page-function.ts";\nimport { evaluate } from "./page-runner.ts";\nconst forward = (pageFunction: PageFunction): string => evaluate(pageFunction);\nexport const send = (pageFunction: PageFunction): string => forward(pageFunction);\n';
                assert.deepEqual(findingsOutside(source), []);
            });
        });

        describe("when it sends a local alias of a function imported from a file that is not in-page", () => {
            test("then it should report it by toString", () => {
                const source =
                    'import { helper } from "./helpers.ts";\nconst alias = helper;\nexport const text = alias.toString();\n';
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });

            test("then it should report it as a page function", () => {
                const source =
                    'import { helper } from "./helpers.ts";\nimport { evaluate } from "./page-runner.ts";\nconst alias = helper;\nexport const result = evaluate(alias);\n';
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });
        });

        describe("when it passes such a function to its own function that sends its parameter by toString", () => {
            test("then it should report it", () => {
                const source =
                    'import { helper } from "./helpers.ts";\nconst send = (sent: () => number): string => sent.toString();\nexport const text = send(helper);\n';
                const findings = findingsOutside(source);
                assert.notDeepEqual(findings, []);
                assert.deepEqual(
                    findings.filter((messageId) => messageId !== "sentFromElsewhere"),
                    [],
                );
            });
        });

        describe("when it passes such a function where a page function or undefined is taken", () => {
            test("then it should report it as sent from elsewhere", () => {
                const source =
                    'import { helper } from "./helpers.ts";\nimport { evaluateIfGiven } from "./page-runner.ts";\nexport const result = evaluateIfGiven(helper);\n';
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });
        });

        describe("when it sends a method of its own object by toString", () => {
            test("then it should report the method as sent from elsewhere", () => {
                const source =
                    'const page = {\n    read(): string | undefined {\n        return process.env["X"];\n    },\n};\nexport const source = page.read.toString();\n';
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });
        });

        describe("when it passes a method of an object imported from a file that is not in-page", () => {
            test("then it should report the method as sent from elsewhere", () => {
                const source =
                    'import { evaluate } from "./page-runner.ts";\nimport { page } from "./page-methods.ts";\nexport const result = evaluate(page.read);\n';
                assert.deepEqual(findingsOutside(source), ["sentFromElsewhere"]);
            });
        });

        describe("when it sends an in-page function through the in-page module's namespace", () => {
            test("then it should pass, by toString and as a page function", () => {
                const source =
                    'import { evaluate } from "./page-runner.ts";\nimport * as inPage from "./in-page.ts";\nexport const result = evaluate(inPage.probe);\nexport const source = inPage.probe.toString();\n';
                assert.deepEqual(findingsOutside(source), []);
            });
        });
    });
});
