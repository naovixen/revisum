// Reading an approval's strength into a local first still decides by strength when that local is
// compared. A local that holds something else, or a strength used only to choose a label, passes.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import { assertLintFails, assertLintPasses } from "../support/WithEdits.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const ONLY_THE_RULE = { rule: RepositoryRuleName.ApprovalStrength };
const PLANTED_FILE = "planted-strength-local.ts";
const PLANTED_MODULE = `packages/report/src/${PLANTED_FILE}`;

type PlantedSource = { readonly how: string; readonly source: string };

const gateOn = (...body: readonly string[]): string =>
    [
        "import type { Approval } from '@revisum/contracts';",
        "export function opensGate(approval: Approval): boolean {",
        ...body.map((line) => `  ${line}`),
        "}",
        "",
    ].join("\n");

const COMPARISONS_THROUGH_A_LOCAL: readonly PlantedSource[] = [
    {
        how: "compares a local holding the strength with 'verified'",
        source: gateOn("const level = approval.strength;", "return level === 'verified';"),
    },
    {
        how: "compares 'declared' with a local holding the strength",
        source: gateOn("const level = approval.strength;", "return 'declared' !== level;"),
    },
];

const NEIGHBOURS_THAT_DECIDE_NOTHING_BY_STRENGTH: readonly PlantedSource[] = [
    {
        how: "looks a label up with a local holding the strength",
        source: gateOn(
            "const LABELS = { verified: 'Verified', declared: 'Declared' };",
            "const level = approval.strength;",
            "return LABELS[level].length > 0;",
        ),
    },
    {
        how: "compares a local holding another field with 'verified'",
        source: gateOn(
            "const level = approval.subject.kind;",
            "return String(level) === 'verified';",
        ),
    },
    {
        how: "holds the strength in one local and compares another with 'verified'",
        source: gateOn(
            "const level = approval.strength;",
            "const status = approval.subject.kind;",
            "return level.length > 0 && String(status) === 'verified';",
        ),
    },
];

describe("Using the approval strength lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given a module that takes an approval", () => {
        for (const { how, source } of COMPARISONS_THROUGH_A_LOCAL) {
            describe(`when it ${how}`, () => {
                test("then it should fail, naming the module", { timeout: TIMEOUT }, () => {
                    assertLintFails(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE), [
                        "approval strength check: ",
                        PLANTED_FILE,
                    ]);
                });
            });
        }

        for (const { how, source } of NEIGHBOURS_THAT_DECIDE_NOTHING_BY_STRENGTH) {
            describe(`when it ${how}`, () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    assertLintPasses(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE));
                });
            });
        }
    });
});
