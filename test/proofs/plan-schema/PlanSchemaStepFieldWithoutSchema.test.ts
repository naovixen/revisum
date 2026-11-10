// A step field the schema has no entry for must stop the schema being built, not leave a step that
// requires a field it doesn't declare. A schema that merely differs from the committed file would
// fail as stale, so the proof is that the build itself refuses and says which field of which step.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../../tools/repo-rules/RunRepositoryRules.ts";
import { assertLintFails } from "../repo-rules/support/WithEdits.ts";
import { copyRepository, type ScratchRepository } from "../repo-rules/support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const SCHEMA_SOURCE = "packages/engine/src/plan/schema/PlanJsonSchema.ts";
const FIXTURE_FIELD_ENTRY = /^[ \t]*fixture: .*\r?\n/m;

describe("Using the plan schema check", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given a step field with no entry in the schema's table of fields", () => {
        describe("when the check runs", () => {
            test(
                "then it should fail because the schema cannot be built, naming the field",
                { timeout: TIMEOUT },
                () => {
                    const outcome = scratch.lintWithEdit(
                        SCHEMA_SOURCE,
                        (text) => text.replace(FIXTURE_FIELD_ENTRY, ""),
                        { rule: RepositoryRuleName.PlanSchema },
                    );
                    assertLintFails(outcome, ["cannot build the plan schema", "fixture"]);
                },
            );
        });
    });
});
