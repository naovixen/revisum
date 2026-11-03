// A suite's container makes test-results in the output folder as its own user. The host may be another
// user, as on a CI runner, and then can't empty a folder of that user's. That must not stop the next
// suite run, or a first run whose setup made the folder, and the earlier results must still have gone
// before the suite starts. The suite here is the fixture image's stand-in, on real Docker, and looks for
// what the earlier run left as soon as it starts.
//
// On Windows a bind mount keeps no container uid, so the host can always empty the folder, and for root
// no folder is out of reach. Neither can show this, so these tests run on any other host, whatever its
// uid: the container is given another. The same runs on a host that can empty the folder are the
// counter-example, and they run everywhere.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runSuite } from "@revisum/cli";
import { WORKLOAD_OUTPUT_PATH } from "@revisum/contracts";
import { environmentSecretStore, type RunResult } from "@revisum/engine";
import { dockerCliEngine, workloadRunner, type ContainerEngine } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../support/repository.ts";
import {
    SUITE_NAME,
    evidenceModeInput,
    parsedProject,
    projectFileWithEvidence,
    suiteInput,
} from "../unit/engine/evidence-examples.ts";
import { fixtureWorkloadImage } from "./workload-run.ts";

const TIMEOUT = 600_000;
const SUITE_FOLDER = "suite";
const RESULTS_FOLDER = "test-results";
const LEFT_BEHIND = "left-by-the-container.txt";
const WHAT_THE_SUITE_FOUND = "what-the-suite-found.json";
const RESULTS_PATH_INSIDE = `${WORKLOAD_OUTPUT_PATH}/${RESULTS_FOLDER}`;

const SUITE_MODULE = `
  import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
  export const describe = 'a suite that keeps results';
  export const tests = [{
    title: 'looks for earlier results, then leaves its own',
    run: () => {
      const earlierResultsLeft = existsSync('${RESULTS_PATH_INSIDE}/${LEFT_BEHIND}');
      writeFileSync('${WORKLOAD_OUTPUT_PATH}/${WHAT_THE_SUITE_FOUND}', JSON.stringify({ earlierResultsLeft }));
      mkdirSync('${RESULTS_PATH_INSIDE}', { recursive: true });
      writeFileSync('${RESULTS_PATH_INSIDE}/${LEFT_BEHIND}', 'from this run');
    },
  }];`;

const SETUP_MODULE_NAME = "makes-results.mjs";
const SETUP_MODULE = `
  import { mkdirSync, writeFileSync } from 'node:fs';
  mkdirSync('${RESULTS_PATH_INSIDE}', { recursive: true });
  writeFileSync('${RESULTS_PATH_INSIDE}/${LEFT_BEHIND}', 'from setup');`;

const hostUid = process.getuid?.();
const whyThisHostCantShowIt = (): string | false => {
    if (hostUid === undefined) {
        return "a Windows bind mount keeps no container uid";
    }
    return hostUid === 0 ? "root can empty any folder" : false;
};

// Any uid but the host's, so the suite's container makes folders the host can't empty.
const ANOTHER_USER = hostUid === 1000 ? "1001:1001" : "1000:1000";

const engineRunningSuitesAs = (user: string | undefined): ContainerEngine => {
    const engine = dockerCliEngine();
    return user === undefined ? engine : { ...engine, imageUser: () => Promise.resolve(user) };
};

// The host's own user where it has one, so nothing stops it emptying what the container made.
const hostUser = hostUid === undefined ? undefined : `${hostUid}:${process.getgid?.() ?? hostUid}`;

let image: string;
let checkout: string;
const foldersToRemove: string[] = [];

const newOutputFolder = (): string => {
    const folder = mkdtempSync(join(tmpdir(), "suite-into-a-used-folder-"));
    foldersToRemove.push(folder);
    return folder;
};

before(
    async () => {
        image = await fixtureWorkloadImage();
        checkout = mkdtempSync(join(tmpdir(), "suite-into-a-used-folder-checkout-"));
        mkdirSync(join(checkout, SUITE_FOLDER));
        writeFileSync(join(checkout, SUITE_FOLDER, "keeps-results.spec.mjs"), SUITE_MODULE);
        writeFileSync(join(checkout, SUITE_FOLDER, SETUP_MODULE_NAME), SETUP_MODULE);
        // The container's user only has to read it.
        chmodSync(checkout, 0o755);
        chmodSync(join(checkout, SUITE_FOLDER), 0o755);
    },
    { timeout: TIMEOUT },
);

after(() => {
    rmSync(checkout, { recursive: true, force: true });
    for (const folder of foldersToRemove) {
        try {
            rmSync(folder, { recursive: true, force: true });
        } catch {
            // Another user's files, which is what these tests are about, in a temporary folder.
        }
    }
});

type SuiteFields = { readonly setupCommand?: readonly string[] };

const runSuiteInto = (
    outputDirectory: string,
    containerUser: string | undefined,
    fields: SuiteFields = {},
): Promise<RunResult> => {
    const suite = suiteInput({
        image,
        command: ["playwright", "test"],
        workingDirectory: SUITE_FOLDER,
        paths: [`${SUITE_FOLDER}/**`],
        projects: ["chromium"],
        environment: {},
        ...fields,
    });
    if (fields.setupCommand === undefined) {
        Reflect.deleteProperty(suite, "setupCommand");
    }
    return runSuite(
        parsedProject(projectFileWithEvidence(evidenceModeInput([suite]))),
        SUITE_NAME,
        {
            workload: workloadRunner({
                engine: engineRunningSuitesAs(containerUser),
                repositoryRoot: REPOSITORY_ROOT,
                checkout,
            }),
            secrets: environmentSecretStore({}),
            checkout,
            outputDirectory,
            pass: "gating",
        },
    );
};

const whatTheSuiteFoundIn = (outputDirectory: string): unknown =>
    JSON.parse(readFileSync(join(outputDirectory, WHAT_THE_SUITE_FOUND), "utf8"));

const SUITE_FOUND_NOTHING_EARLIER = { earlierResultsLeft: false };

type UsedFolderRuns = {
    readonly result: RunResult;
    readonly found: () => unknown;
};

const secondRunInto = async (containerUser: string | undefined): Promise<UsedFolderRuns> => {
    const outputDirectory = newOutputFolder();
    const first = await runSuiteInto(outputDirectory, containerUser);
    assert.equal(first.state, "Passed", JSON.stringify(first));
    const result = await runSuiteInto(outputDirectory, containerUser);
    return { result, found: () => whatTheSuiteFoundIn(outputDirectory) };
};

const firstRunAfterSetup = async (containerUser: string | undefined): Promise<UsedFolderRuns> => {
    const outputDirectory = newOutputFolder();
    const result = await runSuiteInto(outputDirectory, containerUser, {
        setupCommand: ["node", SETUP_MODULE_NAME],
    });
    return { result, found: () => whatTheSuiteFoundIn(outputDirectory) };
};

describe("Using a suite run on real Docker", () => {
    describe("given a host whose user can't empty what the suite's container made", () => {
        describe("and an earlier suite run that left results in the output folder", () => {
            describe("when a second suite runs into the same folder", () => {
                test(
                    "then it should run the suite, with the earlier results gone before it starts",
                    { timeout: TIMEOUT, skip: whyThisHostCantShowIt() },
                    async () => {
                        const { result, found } = await secondRunInto(ANOTHER_USER);
                        assert.equal(result.state, "Passed", JSON.stringify(result));
                        assert.deepEqual(found(), SUITE_FOUND_NOTHING_EARLIER);
                    },
                );
            });
        });

        describe("and a setup command that makes the results folder", () => {
            describe("when a first suite runs into that folder", () => {
                test(
                    "then it should run the suite, with what setup left gone before it starts",
                    { timeout: TIMEOUT, skip: whyThisHostCantShowIt() },
                    async () => {
                        const { result, found } = await firstRunAfterSetup(ANOTHER_USER);
                        assert.equal(result.state, "Passed", JSON.stringify(result));
                        assert.deepEqual(found(), SUITE_FOUND_NOTHING_EARLIER);
                    },
                );
            });
        });
    });

    describe("given a host whose user can empty what the suite's container made", () => {
        describe("and an earlier suite run that left results in the output folder", () => {
            describe("when a second suite runs into the same folder", () => {
                test(
                    "then it should run the suite, with the earlier results gone before it starts",
                    { timeout: TIMEOUT },
                    async () => {
                        const { result, found } = await secondRunInto(hostUser);
                        assert.equal(result.state, "Passed", JSON.stringify(result));
                        assert.deepEqual(found(), SUITE_FOUND_NOTHING_EARLIER);
                    },
                );
            });
        });

        describe("and a setup command that makes the results folder", () => {
            describe("when a first suite runs into that folder", () => {
                test(
                    "then it should run the suite, with what setup left gone before it starts",
                    { timeout: TIMEOUT },
                    async () => {
                        const { result, found } = await firstRunAfterSetup(hostUser);
                        assert.equal(result.state, "Passed", JSON.stringify(result));
                        assert.deepEqual(found(), SUITE_FOUND_NOTHING_EARLIER);
                    },
                );
            });
        });
    });
});
