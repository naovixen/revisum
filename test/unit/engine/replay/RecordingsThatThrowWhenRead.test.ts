// A recording is read back from outside, and its decoder promises an answer for every value it is
// handed, not just for what JSON.parse makes. A field whose getter throws or a proxy that throws is
// refused like any other recording that cannot be read, and never thrown out of the replay.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
    proxyThatThrows,
    revokedProxy,
    withThrowingGetter,
} from "#test-support/ProxyThatThrows.ts";
import { withValue, type JsonRecord } from "../plan/examples/GoldenPlan.ts";
import {
    closedScenario,
    refused,
    removeFakeExecutables,
    replayRun,
    runScenario,
    type ScenarioRun,
} from "./examples/ManifestUnderTest.ts";
import {
    callPlanOf,
    callProjectFile,
    CREATE_ORDER,
    SECRET_VALUES,
} from "../run/executors/service-calls/examples/ShopService.ts";

const VERSION_UNSUPPORTED_AT_THE_TOP = { code: "version-unsupported", path: "$" };
const mismatchAt = (path: string): unknown => ({ code: "replay-mismatch", path });

const jsonOf = (value: unknown): JsonRecord => JSON.parse(JSON.stringify(value)) as JsonRecord;

const HOSTILE_RECORDINGS: readonly {
    readonly name: string;
    readonly hostile: (recording: JsonRecord) => unknown;
    readonly expected: unknown;
}[] = [
    {
        name: "a recording whose schema has a getter that throws",
        hostile: (recording) => withThrowingGetter(recording, "schema"),
        expected: VERSION_UNSUPPORTED_AT_THE_TOP,
    },
    {
        name: "a proxy that throws on every read as the recording",
        hostile: (recording) => proxyThatThrows(recording),
        expected: VERSION_UNSUPPORTED_AT_THE_TOP,
    },
    {
        name: "a revoked proxy as the recording",
        hostile: (recording) => revokedProxy(recording),
        expected: VERSION_UNSUPPORTED_AT_THE_TOP,
    },
    {
        name: "the service calls in a proxy over a list that throws on every read",
        hostile: (recording) => withValue(recording, ["serviceCalls"], proxyThatThrows([])),
        expected: mismatchAt("$.serviceCalls"),
    },
    {
        name: "the service calls in a revoked proxy over a list",
        hostile: (recording) => withValue(recording, ["serviceCalls"], revokedProxy([])),
        expected: mismatchAt("$.serviceCalls"),
    },
    {
        name: "a first service reply whose request hash has a getter that throws",
        hostile: (recording) =>
            withValue(
                recording,
                ["serviceCalls", 0],
                withThrowingGetter({ requestSha256: "" }, "requestSha256"),
            ),
        expected: mismatchAt("$.serviceCalls[0]"),
    },
];

describe("Using a replay of a recorded run", () => {
    let ran: ScenarioRun;

    before(async () => {
        ran = await runScenario(
            {
                ...closedScenario(
                    callProjectFile({}, {}, { replay: { recordReplies: true } }),
                    callPlanOf([CREATE_ORDER]),
                ),
                environment: SECRET_VALUES,
            },
            { record: true },
        );
    });

    after(removeFakeExecutables);

    for (const { name, hostile, expected } of HOSTILE_RECORDINGS) {
        describe(`given ${name}`, () => {
            describe("when the run is replayed", () => {
                test("then it should refuse the recording without throwing", async () => {
                    const recording = hostile(jsonOf(ran.recording));
                    const replay = await replayRun(ran, { recording });
                    assert.deepEqual(refused(replay.answer), expected);
                });
            });
        });
    }
});
