// A list holding 'person-verified' without 'person-declared' is the same gate as comparing with
// 'person-verified' alone, since a declared person falls outside it. A list holding both, or a table
// of labels, leaves nobody out.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../tools/RunRepositoryRules.ts";
import { assertLintFails, assertLintPasses } from "./scratch-edits.ts";
import { copyRepository, type ScratchRepository } from "./scratch-repository.ts";

const TIMEOUT = 300_000;
const ONLY_THE_RULE = { rule: RepositoryRuleName.PersonGates };
const PLANTED_FILE = "planted-person-list.ts";
const PLANTED_MODULE = `packages/report/src/${PLANTED_FILE}`;

type PlantedSource = { readonly how: string; readonly source: string };

const LISTS_THAT_LEAVE_OUT_A_DECLARED_PERSON: readonly PlantedSource[] = [
    {
        how: "tests membership of a list of 'person-verified' alone",
        source: "export const isPerson = (type: string): boolean => ['person-verified'].includes(type);\n",
    },
    {
        how: "tests membership of a double-quoted list of 'person-verified' alone",
        source: 'export const isPerson = (type: string): boolean => ["person-verified"].includes(type);\n',
    },
    {
        how: "tests membership of a list with 'person-verified' and no 'person-declared'",
        source: "export const counts = (type: string): boolean => ['person-verified', 'agent'].includes(type);\n",
    },
];

const LISTS_THAT_LEAVE_NOBODY_OUT: readonly PlantedSource[] = [
    {
        how: "tests membership of a list with both person types",
        source: "export const isPerson = (type: string): boolean => ['person-verified', 'person-declared'].includes(type);\n",
    },
    {
        how: "tests membership of a list with both person types the other way round",
        source: "export const isPerson = (type: string): boolean => ['person-declared', 'person-verified'].includes(type);\n",
    },
    {
        how: "tests membership of the shared person types",
        source: [
            "import { PERSON_ACTOR_TYPES } from '@revisum/contracts';",
            "export const isPerson = (type: never): boolean => PERSON_ACTOR_TYPES.includes(type);",
            "",
        ].join("\n"),
    },
    {
        how: "looks a label up in a table keyed by actor type",
        source: "export const LABELS = { 'person-verified': 'Verified', 'person-declared': 'Declared' };\n",
    },
    {
        how: "tests membership of a list without either person type",
        source: "export const isMachine = (type: string): boolean => ['agent', 'ci'].includes(type);\n",
    },
];

describe("Using the person gate lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given a module that decides who counts as a person", () => {
        for (const { how, source } of LISTS_THAT_LEAVE_OUT_A_DECLARED_PERSON) {
            describe(`when it ${how}`, () => {
                test("then it should fail, naming the module", { timeout: TIMEOUT }, () => {
                    assertLintFails(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE), [
                        "person gate check: ",
                        PLANTED_FILE,
                    ]);
                });
            });
        }

        for (const { how, source } of LISTS_THAT_LEAVE_NOBODY_OUT) {
            describe(`when it ${how}`, () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    assertLintPasses(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE));
                });
            });
        }
    });
});
