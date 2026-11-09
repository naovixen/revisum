// What the real proxy container does when an upstream or its own disk misbehaves.
//   - A status 000 from an upstream is not one Node can write back: the proxy must answer 502 and go
//     on answering, rather than die and take the run's egress with it.
//   - A /tmp that fills up must not stop the proxy either, but the decisions it can no longer write
//     are lost. It marks its record as lost, so a plan run drops to the host level of guarantee and a
//     workload ends Errored with egress-unread, rather than show a record with gaps as complete.
//   - A record too long to read back whole is just as incomplete, so it costs the run the same level.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { PRODUCT, type Runner, type RunnerHandle } from "@revisum/contracts";
import {
    dockerCliEngine,
    dockerRunner,
    runDocker,
    type ContainerEngine,
    type RunnerLogEntry,
} from "@revisum/runner";
import type { RunResult } from "@revisum/engine";
import { createCleanUpScope } from "../../support/CleanUpScope.ts";
import { REPOSITORY_ROOT } from "../../support/repository/RepositoryRoot.ts";
import { declaredService, egressPolicy } from "../../unit/runner/examples/DeclaredService.ts";
import { execInside, holdRunOpen, jsonInside, pinnedRunImage } from "../support/IsolatedRun.ts";
import { fixtureWorkloadImage, runFixtureSuite } from "../support/RunInWorkload.ts";

const TIMEOUT = 300_000;
const SERVER_PORT = 4555;
const SERVER_SERVICE = "status-fixture";
const LISTENING = "listening";
const IPV4_ADDRESS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const UNDECLARED_URL = "http://undeclared.invalid/";
const RECORDS_STATE_FILE = "/tmp/egress-records-state";
const DECISIONS_FILE = "/tmp/egress-decisions.jsonl";
const DECISION_LINE = `${JSON.stringify({ origin: "http://overflow.invalid", decision: "blocked" })}\n`;
const SHORT_RECORD_DECISIONS = 1_000;
// Far past the most the runner will keep of one command's output, which is about 16 MiB.
const OVERSIZED_RECORD_BYTES = 40 * 1024 * 1024;
const SECRET_VALUE = "made-up-secret-value-for-the-proxy-0042";
// A small append still fits in the last page of a full tmpfs, so one request is not enough to lose one.
const FLOOD_REQUESTS = 400;
const FILL_TMP = ["sh", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M 2>/dev/null; true"];

const serverScript = `require('node:net').createServer((socket) => socket.once('data', (data) => socket.end(
  data.toString().includes('/zero') ? 'HTTP/1.1 000 Nothing\\r\\ncontent-length: 0\\r\\n\\r\\n'
    : 'HTTP/1.1 200 OK\\r\\ncontent-length: 4\\r\\nconnection: close\\r\\n\\r\\nfine'))).listen(${SERVER_PORT}, '0.0.0.0', () => console.log(${JSON.stringify(LISTENING)}));`;

type ProxiedAnswer = { readonly status: number; readonly mark: string | null };

// Asks the run's proxy for a URL from inside the run container, and prints its status and its mark.
const askScript = (url: string): string => `
  const proxy = new URL(process.env.SERVICE_PROXY);
  require('node:http').request({ host: proxy.hostname, port: proxy.port, path: ${JSON.stringify(url)} }, (answer) => {
    answer.resume();
    answer.on('end', () => console.log(JSON.stringify({ status: answer.statusCode, mark: answer.headers['x-egress-decision'] ?? null })));
  }).on('error', (error) => { console.error(error.message); process.exit(1); }).end();`;

// Asks in turn, and prints how many answers of each status came back. A run container has a service
// address that answers, and a suite's workload container has only HTTP_PROXY, which also answers.
const floodScript = (url: string, count: number): string => `
  const http = require('node:http');
  const proxy = new URL(process.env.SERVICE_PROXY ?? process.env.HTTP_PROXY);
  const agent = new http.Agent();
  const ask = () => new Promise((resolve) => http.request({ agent, host: proxy.hostname, port: proxy.port, path: ${JSON.stringify(url)} }, (answer) => {
    answer.resume();
    answer.on('end', () => resolve(answer.statusCode));
  }).on('error', (error) => resolve(error.code)).end());
  (async () => {
    const statuses = {};
    for (let index = 0; index < ${count}; index += 1) { const status = await ask(); statuses[status] = (statuses[status] ?? 0) + 1; }
    console.log(JSON.stringify(statuses));
  })();`;

// Appends this many decision lines to the proxy's own record, as a page making that many requests would.
const appendDecisions = (count: number): readonly string[] => [
    "node",
    "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(DECISIONS_FILE)}, ${JSON.stringify(DECISION_LINE)}.repeat(${count}))`,
];

// The engine, and a way to reach the proxy it started: its container is the runner's own.
function engineWatchingTheProxy(inner: ContainerEngine) {
    let proxyId: string | undefined;
    const engine: ContainerEngine = {
        ...inner,
        async startContainer(options) {
            const started = await inner.startContainer(options);
            if (started.ok && options.name.endsWith("-proxy")) {
                proxyId = started.value;
            }
            return started;
        },
    };
    const execInProxy = async (command: readonly string[]) => {
        assert.ok(proxyId !== undefined, "the proxy has not started");
        const done = await inner.exec(proxyId, command);
        assert.ok(done.ok, JSON.stringify(done));
        return done.value;
    };
    return { engine, execInProxy };
}

let serverName: string | undefined;
let serverOrigin: string;

before(
    async () => {
        const image = await pinnedRunImage();
        const name = `${PRODUCT.name}-status-fixture-${randomBytes(6).toString("hex")}`;
        const started = await runDocker([
            "run",
            "--detach",
            "--rm",
            "--name",
            name,
            "--network",
            "bridge",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "node",
            image,
            "node",
            "-e",
            serverScript,
        ]);
        assert.equal(started.status, 0, `the fixture server did not start: ${started.stderr}`);
        serverName = name;
        for (
            let tries = 0;
            tries < 50 && !(await runDocker(["logs", name])).stdout.includes(LISTENING);
            tries++
        ) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const inspected = await runDocker([
            "inspect",
            "--format",
            "{{.NetworkSettings.Networks.bridge.IPAddress}}",
            name,
        ]);
        const address = inspected.stdout.trim();
        assert.match(
            address,
            IPV4_ADDRESS,
            `the fixture server has no bridge address: ${inspected.stdout} ${inspected.stderr}`,
        );
        serverOrigin = `http://${address}:${SERVER_PORT}`;
    },
    { timeout: TIMEOUT },
);

after(
    async () => {
        if (serverName !== undefined) {
            await runDocker(["stop", "--time", "1", serverName]);
        }
    },
    { timeout: TIMEOUT },
);

describe("Using the egress proxy on real Docker", () => {
    describe("given a plan run through a proxy that can reach a declared server", () => {
        const logged: RunnerLogEntry[] = [];
        const { engine, execInProxy } = engineWatchingTheProxy(dockerCliEngine());
        const cleanUps = createCleanUpScope();
        let runner: Runner;
        let handle: RunnerHandle;
        const ask = async (url: string) =>
            (await jsonInside(handle, askScript(url))) as ProxiedAnswer;

        before(
            async () => {
                runner = dockerRunner({
                    engine,
                    repositoryRoot: REPOSITORY_ROOT,
                    inputs: [],
                    log: (entry) => {
                        logged.push(entry);
                    },
                    services: [declaredService(SERVER_SERVICE, serverOrigin, true)],
                });
                const started = await holdRunOpen(
                    runner,
                    await pinnedRunImage(),
                    egressPolicy({ allowOrigins: [serverOrigin], allowServices: [SERVER_SERVICE] }),
                );
                assert.ok(started.ok, JSON.stringify(started));
                handle = started.value;
                const held = started.value;
                cleanUps.add(() => held.stop());
            },
            { timeout: TIMEOUT },
        );

        after(() => cleanUps.runAll(), { timeout: TIMEOUT });

        describe("when the server answers one request with a status 000", () => {
            let zeroAnswer: ProxiedAnswer;
            let nextAnswer: ProxiedAnswer;
            before(
                async () => {
                    zeroAnswer = await ask(`${serverOrigin}/zero`);
                    nextAnswer = await ask(`${serverOrigin}/page`);
                },
                { timeout: TIMEOUT },
            );

            test("then it should answer that request 502 and mark it unreachable", () => {
                assert.deepEqual(zeroAnswer, { status: 502, mark: "unreachable" });
            });

            test("then it should go on to answer the next request", () => {
                assert.deepEqual(nextAnswer, { status: 200, mark: null });
            });

            test("then it should lose nothing from the run's record", () => {
                assert.equal(handle.guaranteeLevel(), "isolated");
                assert.equal(handle.proxyDecisions().length, 2);
            });
        });

        describe("when its /tmp has filled up and more requests come", () => {
            let decisionsBefore: number;
            let blocked: ProxiedAnswer;
            let flood: unknown;
            let forwarded: ProxiedAnswer;
            let recordsState: string;
            before(
                async () => {
                    decisionsBefore = handle.proxyDecisions().length;
                    await execInProxy(FILL_TMP);
                    blocked = await ask(UNDECLARED_URL);
                    flood = await jsonInside(handle, floodScript(UNDECLARED_URL, FLOOD_REQUESTS));
                    forwarded = await ask(`${serverOrigin}/page`);
                    recordsState = (await execInProxy(["cat", RECORDS_STATE_FILE])).stdout;
                },
                { timeout: TIMEOUT },
            );

            test("then it should still block what it was blocking", () => {
                assert.deepEqual(blocked, { status: 403, mark: "blocked" });
                assert.deepEqual(flood, { 403: FLOOD_REQUESTS });
            });

            test("then it should still forward what it was forwarding", () => {
                assert.deepEqual(forwarded, { status: 200, mark: null });
            });

            test("then it should mark its record as lost", () => {
                assert.equal(recordsState, "lost");
            });

            test("then it should drop the run to the host level of guarantee", () => {
                assert.equal(handle.guaranteeLevel(), "host");
                assert.ok(
                    logged.some((entry) => entry.code === "egress-unenforceable"),
                    JSON.stringify(logged),
                );
            });

            test("then it should have left some of those requests unrecorded", () => {
                assert.ok(
                    handle.proxyDecisions().length < decisionsBefore + FLOOD_REQUESTS + 2,
                    "every decision was recorded",
                );
            });
        });
    });

    describe("given a plan run whose proxy has written a long record", () => {
        const logged: RunnerLogEntry[] = [];
        const { engine, execInProxy } = engineWatchingTheProxy(dockerCliEngine());
        const cleanUps = createCleanUpScope();
        let handle: RunnerHandle;

        before(
            async () => {
                const started = await holdRunOpen(
                    dockerRunner({
                        engine,
                        repositoryRoot: REPOSITORY_ROOT,
                        inputs: [],
                        log: (entry) => {
                            logged.push(entry);
                        },
                    }),
                    await pinnedRunImage(),
                    egressPolicy({ allowOrigins: [] }),
                );
                assert.ok(started.ok, JSON.stringify(started));
                handle = started.value;
                const held = started.value;
                cleanUps.add(() => held.stop());
            },
            { timeout: TIMEOUT },
        );

        after(() => cleanUps.runAll(), { timeout: TIMEOUT });

        describe("when the record still fits in what the runner reads back", () => {
            let decisionsBefore: number;
            before(
                async () => {
                    decisionsBefore = handle.proxyDecisions().length;
                    await execInProxy(appendDecisions(SHORT_RECORD_DECISIONS));
                    await execInside(handle, ["true"]);
                },
                { timeout: TIMEOUT },
            );

            test("then it should read every decision and stay isolated", () => {
                assert.equal(
                    handle.proxyDecisions().length,
                    decisionsBefore + SHORT_RECORD_DECISIONS,
                );
                assert.equal(handle.guaranteeLevel(), "isolated");
            });
        });

        describe("when the record has grown past what the runner reads back", () => {
            before(
                async () => {
                    await execInProxy(
                        appendDecisions(Math.ceil(OVERSIZED_RECORD_BYTES / DECISION_LINE.length)),
                    );
                    await execInside(handle, ["true"]);
                },
                { timeout: TIMEOUT },
            );

            test("then it should drop the run to the host level of guarantee", () => {
                assert.equal(handle.guaranteeLevel(), "host");
                assert.ok(
                    logged.some((entry) => entry.code === "egress-unenforceable"),
                    JSON.stringify(logged),
                );
            });
        });
    });

    describe("given a workload whose proxy's /tmp fills up while its suite runs", () => {
        describe("when the run ends", () => {
            let result: RunResult;
            let wasFlooded = false;
            before(
                async () => {
                    const inner = dockerCliEngine();
                    const { engine, execInProxy } = engineWatchingTheProxy(inner);
                    const flooding: ContainerEngine = {
                        ...engine,
                        async exec(containerId, command, names) {
                            if (command.includes("--reporter=json")) {
                                wasFlooded = true;
                                await execInProxy(FILL_TMP);
                                const asked = await inner.exec(containerId, [
                                    "node",
                                    "-e",
                                    floodScript(UNDECLARED_URL, FLOOD_REQUESTS),
                                ]);
                                assert.ok(asked.ok, JSON.stringify(asked));
                                assert.deepEqual(
                                    JSON.parse(asked.value.stdout.trim()),
                                    { 403: FLOOD_REQUESTS },
                                    asked.value.stderr,
                                );
                            }
                            return inner.exec(containerId, command, names);
                        },
                    };
                    ({ result } = await runFixtureSuite(
                        await fixtureWorkloadImage(),
                        SECRET_VALUE,
                        flooding,
                    ));
                },
                { timeout: TIMEOUT },
            );

            test("then it should have flooded the proxy during the suite", () => {
                assert.equal(wasFlooded, true);
            });

            test("then it should end Errored with egress-unread", () => {
                assert.equal(result.state, "Errored");
                assert.equal(result.evidence?.outcomeCode, "egress-unread");
            });

            test("then it should report the egress guarantee lost", () => {
                assert.ok(
                    result.guarantees.lost.some((entry) => entry.guarantee === "egress-enforced"),
                    JSON.stringify(result.guarantees),
                );
            });
        });
    });
});
