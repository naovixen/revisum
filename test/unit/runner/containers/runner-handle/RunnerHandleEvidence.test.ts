// What a run handle keeps of the proxy container's evidence, on a fake container engine that answers
// reads of the proxy's files. Three things a real run depends on:
//   - each applied rewrite is read back, so a mutated run's manifest differs from a plain run's;
//   - the proxy's decisions are read back, and joined with the browser's records the run hands in;
//   - a read that fails keeps what was already read, unless the file simply does not exist yet.
// What these tests assume about shapes the spec leaves open: the runner reads each file with a
// command naming its path, the rewrites' path holds "rewrite" and the decisions' path "decision",
// and each applied rewrite is one JSON line of { origin, name }, as each decision is of { origin, decision }.
// The tests in test/containers/egress/ProxyEvidence.test.ts run the same behaviour on the real proxy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { success, type ExecOutcome, type RunnerHandle } from "@revisum/contracts";
import { buildManifest, manifestHash, type AdapterInfo } from "@revisum/engine";
import { dockerRunner, type ContainerEngine } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../../../support/repository/RepositoryRoot.ts";
import {
    defaultParser,
    signupPlan,
    testProject,
} from "../../../engine/plan/examples/GoldenPlan.ts";
import { fakeContainerEngine } from "../../support/FakeContainerEngine.ts";
import {
    egressPolicy,
    imageDigest,
    origin,
    PINNED_IMAGE_ID,
} from "../../examples/DeclaredService.ts";

const POLICY = egressPolicy({ allowOrigins: ["http://app.test"] });
const APP = origin("http://app.test");
const OUTSIDE = "outside.test:443";

// What reading one of the proxy's files finds: each read takes the next answer, then keeps the last.
type FileAnswers = {
    readonly decisions?: readonly ExecOutcome[];
    readonly rewrites?: readonly ExecOutcome[];
};

const lines = (...entries: readonly unknown[]): ExecOutcome => ({
    exitCode: 0,
    stdout: entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    stderr: "",
});
const notWrittenYet: ExecOutcome = {
    exitCode: 1,
    stdout: "",
    stderr: "cat: /tmp/proxy-file.jsonl: No such file or directory\n",
};

function engineWithProxyFiles(answers: FileAnswers): ContainerEngine {
    const inner = fakeContainerEngine({
        localImageId: PINNED_IMAGE_ID,
        internalNetworks: true,
        probe: "blocked",
    });
    const reads = { decisions: 0, rewrites: 0 };
    const answer = (kind: "decisions" | "rewrites"): ExecOutcome => {
        const kept = answers[kind] ?? [];
        const found = kept[Math.min(reads[kind], kept.length - 1)] ?? notWrittenYet;
        reads[kind] += 1;
        return found;
    };
    return {
        ...inner,
        async exec(containerId, command, environmentNames) {
            const words = command.join(" ");
            if (/rewrite/i.test(words)) {
                return success(answer("rewrites"));
            }
            if (/decision/i.test(words)) {
                return success(answer("decisions"));
            }
            return inner.exec(containerId, command, environmentNames);
        },
    };
}

// Runs `body` inside a run on these files, and gives back the handle for what it reads after the end.
async function ranWith(
    answers: FileAnswers,
    body: (handle: RunnerHandle) => Promise<void> = () => Promise.resolve(),
): Promise<RunnerHandle> {
    const runner = dockerRunner({
        engine: engineWithProxyFiles(answers),
        repositoryRoot: REPOSITORY_ROOT,
    });
    const kept: RunnerHandle[] = [];
    const ended = await runner.withRun(imageDigest(PINNED_IMAGE_ID), POLICY, async (run) => {
        kept.push(run);
        await body(run);
    });
    assert.ok(ended.ok, JSON.stringify(ended));
    const [handle] = kept;
    assert.ok(handle !== undefined);
    return handle;
}

const execOnce = async (handle: RunnerHandle): Promise<void> => {
    await handle.exec(["true"]);
};

// ---- Applied rewrites -------------------------------------------------------------------------------

const HEADING_CHANGED = { origin: APP, name: "heading-changed" };
const STATUS_FLIPPED = { origin: APP, name: "status-flipped" };

test("the handle gives back each rewrite the proxy container wrote to its file", async () => {
    await ranWith({ rewrites: [lines(HEADING_CHANGED, STATUS_FLIPPED)] }, async (handle) => {
        await handle.exec(["true"]);
        assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED, STATUS_FLIPPED]);
    });
});

test("the applied rewrites are still there after the run has stopped and its containers are gone", async () => {
    const handle = await ranWith({ rewrites: [lines(HEADING_CHANGED)] });
    assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED]);
});

test("a line in the rewrites file that is not an applied rewrite is left out", async () => {
    const handle = await ranWith({
        rewrites: [
            {
                exitCode: 0,
                stdout: `not json\n${JSON.stringify({ origin: APP })}\n${JSON.stringify(HEADING_CHANGED)}\n`,
                stderr: "",
            },
        ],
    });
    assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED]);
});

test("counter-example: a run whose proxy applied no rewrite has none, so its file does not exist", async () => {
    const handle = await ranWith({ rewrites: [notWrittenYet] });
    assert.deepEqual(handle.rewritesApplied(), []);
});

test("a mutated run's manifest hash differs from a plain run's, from what each handle read back", async () => {
    const parsed = defaultParser()(signupPlan());
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const target = testProject().matrix[0];
    assert.ok(target !== undefined);
    const adapter: AdapterInfo = {
        id: "cdp",
        version: "0.1.0",
        protocol: "Chrome DevTools Protocol (raw WebSocket)",
    };
    const manifestOf = (handle: RunnerHandle) =>
        buildManifest({
            plan: parsed.value,
            target,
            adapter,
            browser: { name: "chromium", version: "156.0.8078.47" },
            seed: 42,
            fixedTimeMilliseconds: Date.UTC(2026, 10, 1, 9, 0, 0),
            fixtures: [],
            host: { platform: "linux", arch: "x64" },
            responseRewrites: handle.rewritesApplied(),
        });
    const mutated = await ranWith({ rewrites: [lines(HEADING_CHANGED)] });
    const plain = await ranWith({ rewrites: [notWrittenYet] });
    assert.deepEqual(manifestOf(mutated).responseRewrites, [HEADING_CHANGED]);
    assert.ok(!Object.hasOwn(manifestOf(plain), "responseRewrites"));
    assert.notEqual(manifestHash(manifestOf(mutated)), manifestHash(manifestOf(plain)));
});

// ---- Decisions and the browser's records ----------------------------------------------------------------

const OUTSIDE_BLOCKED = { origin: OUTSIDE, decision: "blocked" };
const APP_ALLOWED = { origin: APP, decision: "allowed" };

test("the handle gives back the proxy's decisions, in the order they were made", async () => {
    await ranWith({ decisions: [lines(APP_ALLOWED, OUTSIDE_BLOCKED)] }, async (handle) => {
        await handle.exec(["true"]);
        assert.deepEqual(handle.proxyDecisions(), [APP_ALLOWED, OUTSIDE_BLOCKED]);
    });
});

test("egress events take their channels from the browser's records the run hands in", async () => {
    await ranWith({ decisions: [lines(OUTSIDE_BLOCKED)] }, async (handle) => {
        await handle.exec(["true"]);
        assert.deepEqual(
            handle.egressEvents([{ origin: "wss://outside.test", channel: "websocket" }]),
            [{ origin: "wss://outside.test", channel: "websocket", decision: "blocked" }],
        );
    });
});

test("egress events judge a record with no decision by the direct origins the run hands in", async () => {
    await ranWith({ decisions: [notWrittenYet] }, async (handle) => {
        await handle.exec(["true"]);
        const loopback = origin("http://127.0.0.1:4310");
        const records = [{ origin: loopback, channel: "page" as const }];
        assert.deepEqual(handle.egressEvents(records, [loopback]), [
            { origin: loopback, channel: "page", decision: "allowed" },
        ]);
        assert.deepEqual(handle.egressEvents(records), [
            { origin: loopback, channel: "page", decision: "blocked" },
        ]);
    });
});

test("counter-example: with no records handed in, every decision stays unattributed", async () => {
    await ranWith({ decisions: [lines(OUTSIDE_BLOCKED)] }, async (handle) => {
        await handle.exec(["true"]);
        assert.deepEqual(handle.egressEvents(), [
            { origin: OUTSIDE, channel: "unattributed", decision: "blocked" },
        ]);
    });
});

// ---- A read that fails ------------------------------------------------------------------------------------

const FAILED_READS: readonly { readonly why: string; readonly read: ExecOutcome }[] = [
    {
        why: "the proxy container has stopped",
        read: {
            exitCode: 1,
            stdout: "",
            stderr: "Error response from daemon: container fake-container-1 is not running\n",
        },
    },
    {
        why: "the proxy container is gone",
        read: {
            exitCode: 1,
            stdout: "",
            stderr: "Error response from daemon: No such container: fake-container-1\n",
        },
    },
    {
        why: "Docker could not start the read",
        read: { exitCode: 125, stdout: "", stderr: "docker: error during connect\n" },
    },
    { why: "the read was killed", read: { exitCode: 137, stdout: "", stderr: "" } },
    {
        why: "the file could not be read",
        read: {
            exitCode: 1,
            stdout: "",
            stderr: "cat: /tmp/proxy-file.jsonl: Input/output error\n",
        },
    },
];

for (const { why, read } of FAILED_READS) {
    test(`the decisions already read survive a failed read: ${why}`, async () => {
        const handle = await ranWith(
            { decisions: [lines(OUTSIDE_BLOCKED), read] },
            async (running) => {
                await running.exec(["true"]);
                assert.deepEqual(
                    running.proxyDecisions(),
                    [OUTSIDE_BLOCKED],
                    "the first read found the decision",
                );
                await running.exec(["true"]);
                assert.deepEqual(running.proxyDecisions(), [OUTSIDE_BLOCKED]);
                assert.deepEqual(running.egressEvents(), [
                    { origin: OUTSIDE, channel: "unattributed", decision: "blocked" },
                ]);
            },
        );
        assert.deepEqual(
            handle.proxyDecisions(),
            [OUTSIDE_BLOCKED],
            "ending the run does not lose them either",
        );
    });

    test(`the rewrites already read survive a failed read: ${why}`, async () => {
        const handle = await ranWith({ rewrites: [lines(HEADING_CHANGED), read] }, execOnce);
        assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED]);
    });
}

test("counter-example: a file that does not exist yet reads as no lines, and later lines still arrive", async () => {
    await ranWith({ decisions: [notWrittenYet, lines(OUTSIDE_BLOCKED)] }, async (handle) => {
        await handle.exec(["true"]);
        assert.deepEqual(handle.proxyDecisions(), []);
        await handle.exec(["true"]);
        assert.deepEqual(handle.proxyDecisions(), [OUTSIDE_BLOCKED]);
    });
});
