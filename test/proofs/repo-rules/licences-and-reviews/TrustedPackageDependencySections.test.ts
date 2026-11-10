// The trusted packages may declare no runtime dependency, whichever section of the manifest declares
// it. Runtime here means what the dependency review rule follows: dependencies, optional dependencies
// and peer dependencies, each of which reaches a package's users when it is installed. Dev
// dependencies never run, so they pass, as an empty section does.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import {
    assertLintFails,
    assertLintPasses,
    editJson,
    lintWithEdits,
} from "../support/WithEdits.ts";
import type { LintOutcome } from "../support/ScratchRepository.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const ONLY_THE_RULE = { rule: RepositoryRuleName.Imports };
const RUNTIME_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];
const TRUSTED_PACKAGES = ["contracts", "engine"];

describe("Using the import lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    const lintWithSection = (
        folder: string,
        section: string,
        listed: Readonly<Record<string, string>>,
    ): LintOutcome =>
        lintWithEdits(
            scratch,
            {
                [`packages/${folder}/package.json`]: editJson((manifest) => {
                    manifest[section] = listed;
                }),
            },
            ONLY_THE_RULE,
        );

    for (const folder of TRUSTED_PACKAGES) {
        describe(`given the ${folder} package's manifest`, () => {
            for (const section of RUNTIME_SECTIONS) {
                describe(`when ${section} lists a package`, () => {
                    test("then it should fail, naming the manifest", { timeout: TIMEOUT }, () => {
                        assertLintFails(lintWithSection(folder, section, { "left-pad": "1.3.0" }), [
                            "import check: ",
                            `packages/${folder}/package.json`,
                        ]);
                    });
                });

                describe(`when ${section} is empty`, () => {
                    test("then it should pass", { timeout: TIMEOUT }, () => {
                        assertLintPasses(lintWithSection(folder, section, {}));
                    });
                });
            }

            describe("when devDependencies lists a package", () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    assertLintPasses(
                        lintWithSection(folder, "devDependencies", { "left-pad": "1.3.0" }),
                    );
                });
            });
        });
    }
});
