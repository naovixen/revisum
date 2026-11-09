// Replaying runs that call declared services or run database commands. Their replies cannot be
// pinned, so a project that sets replay.recordReplies has them recorded (recordingPorts wraps the
// run's ports, as cli does), and a replay feeds the recorded replies to the engine in order: it never
// sends a call or runs a command. Without the setting, such a run is never replay-claimed.
//   - each replay runs with a live caller and command runner attached to its ports as spies: they
//     must stay untouched, and the run's own fakes see nothing after the recorded run;
//   - a recording changed on purpose (a request hash, a reply removed or added, a reply's body or
//     output) shows the replay reads it: each ends in a mismatch, never an identical replay.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { replayManifest } from "@revisum/engine";
import {
    DATABASE_PASSWORD,
    OPEN_CART,
    SEED_ORDERS,
    WIPE_ORDERS,
    commandPlan,
    commandProjectFile,
    expectDatabase,
} from "../run/executors/database-commands/examples/Database.ts";
import {
    closedScenario,
    refused,
    removeFakeExecutables,
    replayRun,
    replayed,
    runScenario,
    withExtraReply,
    withLastReplyRemoved,
    withRecordingField,
    withRequestHashChanged,
    withTextReplaced,
    type Replay,
    type Scenario,
    type ScenarioRun,
} from "./examples/ManifestUnderTest.ts";
import { echoesIn } from "../secrets/examples/SecretRun.ts";
import {
    CREATE_ORDER,
    DELETE_ORDER,
    ORDER_ID,
    SECRET_VALUES,
    TOKEN_SECRET,
    callPlanOf,
    callProjectFile,
    expectBackend,
    jsonReply,
    requestLine,
    shopWith,
    withCleanup,
} from "../run/executors/service-calls/examples/ShopService.ts";
import { DATABASE_SECRET } from "../plan/unsafe-features/examples/UnsafePlan.ts";

after(removeFakeExecutables);

const REPLAYS = 20;
const RECORD_REPLIES = { replay: { recordReplies: true } };

// ---- A run with calls: create an order, check the backend has it paid, delete it in cleanup ------

const ORDER_PAID = expectBackend("getOrder", { orderId: { valueName: "orderId" } }, "status", {
    kind: "equals",
    value: "paid",
});
const CALLS_PLAN = withCleanup(callPlanOf([CREATE_ORDER, ORDER_PAID]), [DELETE_ORDER]);
const CALL_COUNT = 3;

const callScenario = (fields: Readonly<Record<string, unknown>>): Scenario => ({
    ...closedScenario(callProjectFile({}, {}, fields), CALLS_PLAN),
    environment: SECRET_VALUES,
});
const RECORDED_CALLS = callScenario(RECORD_REPLIES);
const UNRECORDED_CALLS = callScenario({});

// ---- A run with commands: seed orders, check there are three, wipe them in cleanup ---------------

const COUNT_IS_THREE = expectDatabase("countOrders", "count", { kind: "numberEquals", value: 3 });
const COMMANDS_PLAN = commandPlan([OPEN_CART, SEED_ORDERS, COUNT_IS_THREE], [WIPE_ORDERS]);
const COMMAND_COUNT = 3;

const commandScenario = (fields: Readonly<Record<string, unknown>>): Scenario => ({
    ...closedScenario(commandProjectFile(fields), COMMANDS_PLAN),
    environment: { [DATABASE_SECRET]: DATABASE_PASSWORD },
});
const RECORDED_COMMANDS = commandScenario(RECORD_REPLIES);
const UNRECORDED_COMMANDS = commandScenario({});

// ---- Checks ------------------------------------------------------------------------------------------

function assertNothingSent(
    ran: ScenarioRun,
    replay: Replay,
    sentByRun: { readonly calls: number; readonly commands: number },
): void {
    assert.deepEqual(
        replay.liveServiceRequests,
        [],
        "the replay sent a call through a live caller",
    );
    assert.deepEqual(replay.liveCommands, [], "the replay ran a command through a live runner");
    assert.equal(
        ran.serviceRequests.length,
        sentByRun.calls,
        "the recorded run's caller was handed more requests after the run",
    );
    assert.equal(
        ran.commands.length,
        sentByRun.commands,
        "the recorded run's runner was handed more commands after the run",
    );
}

async function assertReplaysIdentical(
    ran: ScenarioRun,
    sentByRun: { readonly calls: number; readonly commands: number },
): Promise<void> {
    for (let index = 0; index < REPLAYS; index++) {
        const replay = await replayRun(ran);
        const outcome = replayed(replay.answer);
        assert.equal(
            outcome.resultHash,
            ran.result.resultHash,
            `replay ${index + 1} gave another result hash`,
        );
        assert.equal(outcome.identical, true, `replay ${index + 1}`);
        assert.equal(outcome.verdict, "identical", `replay ${index + 1}`);
        assertNothingSent(ran, replay, sentByRun);
    }
}

// ---- Service calls -------------------------------------------------------------------------------------

test(
    "a run with calls, replayed 20 times from its recording, sends no call and gives the same result hash each time",
    { timeout: 120_000 },
    async () => {
        const ran = await runScenario(RECORDED_CALLS, { record: true });
        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
        assert.equal(ran.serviceRequests.length, CALL_COUNT);
        assert.ok(
            ran.manifest.nonHermeticInputs.includes("service-calls"),
            JSON.stringify(ran.manifest.nonHermeticInputs),
        );
        await assertReplaysIdentical(ran, { calls: CALL_COUNT, commands: 0 });
    },
);

test("the recorded responses are what the replay feeds the engine: another recorded body gives another result", async () => {
    const ran = await runScenario(RECORDED_CALLS, { record: true });
    // The created order's status is recorded, never checked, so the replay still runs to the end.
    const replay = await replayRun(ran, {
        recording: withTextReplaced(ran.recording, "pending", "shipped"),
    });
    const outcome = replayed(replay.answer);
    assert.equal(outcome.identical, false);
    assert.notEqual(outcome.resultHash, ran.result.resultHash);
    assertNothingSent(ran, replay, { calls: CALL_COUNT, commands: 0 });
});

test("a response that echoed a secret is recorded without it, and the replay puts it back from its own secret store", async () => {
    const token = SECRET_VALUES[TOKEN_SECRET] ?? assert.fail("no token");
    const echoing = shopWith((request) =>
        requestLine(request) === `GET /api/orders/${ORDER_ID}`
            ? jsonReply(200, { status: "paid", total: 42, echo: { token } })
            : undefined,
    );
    const ran = await runScenario({ ...RECORDED_CALLS, serviceRoute: echoing }, { record: true });
    const text = JSON.stringify(ran.recording);
    for (const value of Object.values(SECRET_VALUES)) {
        assert.deepEqual(echoesIn(text, value), [], "the recording holds a secret");
    }
    const outcome = replayed((await replayRun(ran)).answer);
    assert.equal(outcome.identical, true);
});

const CALL_TAMPERING = [
    {
        name: "a request whose hash differs from the recorded one",
        change: (recording: unknown) => withRequestHashChanged(recording, CALL_COUNT, 1),
        position: 1,
    },
    {
        name: "a request after the last recorded reply",
        change: (recording: unknown) => withLastReplyRemoved(recording, CALL_COUNT),
        position: CALL_COUNT - 1,
    },
    {
        name: "a recorded reply no request used",
        change: (recording: unknown) => withExtraReply(recording, CALL_COUNT),
        position: CALL_COUNT,
    },
] as const;

for (const tampering of CALL_TAMPERING) {
    test(`${tampering.name} ends the replay replay-mismatch at that call`, async () => {
        const ran = await runScenario(RECORDED_CALLS, { record: true });
        const replay = await replayRun(ran, { recording: tampering.change(ran.recording) });
        assert.deepEqual(refused(replay.answer), {
            code: "replay-mismatch",
            kind: "service-call",
            position: tampering.position,
        });
        assertNothingSent(ran, replay, { calls: CALL_COUNT, commands: 0 });
    });
}

test("a project that records replies, replayed with no recording, ends replay-mismatch at the calls", async () => {
    const ran = await runScenario(RECORDED_CALLS, { record: true });
    const replay = await replayRun(ran, { recording: null });
    const error = refused(replay.answer);
    assert.equal(error.code, "replay-mismatch");
    assert.equal(error.kind, "service-call");
    assertNothingSent(ran, replay, { calls: CALL_COUNT, commands: 0 });
});

test("a recording whose schema is newer or which has an unknown key is refused version-unsupported", async () => {
    const ran = await runScenario(RECORDED_CALLS, { record: true });
    for (const recording of [
        withRecordingField(ran.recording, "schema", "revisum.run-recording/v2"),
        withRecordingField(ran.recording, "stderr", []),
    ]) {
        const replay = await replayRun(ran, { recording });
        assert.equal(refused(replay.answer).code, "version-unsupported");
        assert.deepEqual(replay.driverCalls.order, [], "the replay called the driver");
    }
});

// ---- Database commands -------------------------------------------------------------------------------------

test(
    "a run with database commands, replayed 20 times from its recording, runs no command and gives the same result hash each time",
    { timeout: 120_000 },
    async () => {
        const ran = await runScenario(RECORDED_COMMANDS, { record: true });
        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
        assert.equal(ran.commands.length, COMMAND_COUNT);
        assert.ok(
            ran.manifest.nonHermeticInputs.includes("database-commands"),
            JSON.stringify(ran.manifest.nonHermeticInputs),
        );
        await assertReplaysIdentical(ran, { calls: 0, commands: COMMAND_COUNT });
    },
);

test("the recorded outputs are what the replay feeds the engine: another recorded count fails the check", async () => {
    const ran = await runScenario(RECORDED_COMMANDS, { record: true });
    const replay = await replayRun(ran, {
        recording: withTextReplaced(ran.recording, '\\"count\\":3', '\\"count\\":4'),
    });
    const outcome = replayed(replay.answer);
    assert.equal(outcome.identical, false);
    assert.notEqual(outcome.resultHash, ran.result.resultHash);
    assertNothingSent(ran, replay, { calls: 0, commands: COMMAND_COUNT });
});

const COMMAND_TAMPERING = [
    {
        name: "a command whose request hash differs from the recorded one",
        change: (recording: unknown) => withRequestHashChanged(recording, COMMAND_COUNT, 0),
        position: 0,
    },
    {
        name: "a command after the last recorded output",
        change: (recording: unknown) => withLastReplyRemoved(recording, COMMAND_COUNT),
        position: COMMAND_COUNT - 1,
    },
    {
        name: "a recorded output no command used",
        change: (recording: unknown) => withExtraReply(recording, COMMAND_COUNT),
        position: COMMAND_COUNT,
    },
] as const;

for (const tampering of COMMAND_TAMPERING) {
    test(`${tampering.name} ends the replay replay-mismatch at that command`, async () => {
        const ran = await runScenario(RECORDED_COMMANDS, { record: true });
        const replay = await replayRun(ran, { recording: tampering.change(ran.recording) });
        assert.deepEqual(refused(replay.answer), {
            code: "replay-mismatch",
            kind: "database-command",
            position: tampering.position,
        });
        assertNothingSent(ran, replay, { calls: 0, commands: COMMAND_COUNT });
    });
}

// ---- Without the setting -------------------------------------------------------------------------------------

const UNRECORDED = [
    {
        name: "calls",
        scenario: UNRECORDED_CALLS,
        recorded: RECORDED_CALLS,
        sent: { calls: CALL_COUNT, commands: 0 },
    },
    {
        name: "database commands",
        scenario: UNRECORDED_COMMANDS,
        recorded: RECORDED_COMMANDS,
        sent: { calls: 0, commands: COMMAND_COUNT },
    },
] as const;

for (const unrecorded of UNRECORDED) {
    test(`without replay.recordReplies, a run with ${unrecorded.name} is refused replay-not-claimed and nothing is sent`, async () => {
        const ran = await runScenario(unrecorded.scenario);
        const claimed = replayManifest(ran.manifest);
        assert.equal(claimed.ok ? "claimed" : claimed.error.code, "replay-not-claimed");
        const replay = await replayRun(ran, { recording: null });
        assert.equal(refused(replay.answer).code, "replay-not-claimed");
        assert.deepEqual(replay.driverCalls.order, [], "the replay called the driver");
        assertNothingSent(ran, replay, unrecorded.sent);
    });

    test(`without replay.recordReplies, a recording made anyway does not make a run with ${unrecorded.name} replay-claimed`, async () => {
        const ran = await runScenario(unrecorded.scenario, { record: true });
        const replay = await replayRun(ran);
        assert.equal(refused(replay.answer).code, "replay-not-claimed");
        assertNothingSent(ran, replay, unrecorded.sent);
    });

    test(`counter-example: with replay.recordReplies, the same run with ${unrecorded.name} is replay-claimed`, async () => {
        const ran = await runScenario(unrecorded.recorded, { record: true });
        assert.equal(replayManifest(ran.manifest).ok, true);
        assert.equal(replayed((await replayRun(ran)).answer).identical, true);
    });
}
