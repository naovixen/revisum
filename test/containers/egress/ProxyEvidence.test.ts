// What the real proxy container leaves behind for the run's evidence.
//   - A browser mutant: a fixture server on Docker's default bridge, a private declared service
//     the run's proxy reaches, is asked for its page through the proxy, which rewrites it. The
//     handle reads the applied rewrite back from the proxy's container, so the mutated run's
//     manifest differs from a plain run's. The plain run, against the same server, is the counter-example.
//   - A failed read: once the proxy's container has stopped, its files cannot be read, and the
//     decisions already read must survive. A file not yet written, in a fresh run, still reads as no lines.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
    PRODUCT,
    type AppliedRewrite,
    type EgressPolicy,
    type RunnerHandle,
} from "@revisum/contracts";
import { buildManifest, manifestHash, type AdapterInfo } from "@revisum/engine";
import { runDocker, type ResponseRewrite } from "@revisum/runner";
import {
    defaultParser,
    signupPlan,
    testProject,
} from "../../unit/engine/plan/examples/GoldenPlan.ts";
import {
    declaredService,
    egressPolicy,
    origin,
} from "../../unit/runner/examples/DeclaredService.ts";
import { jsonInside, pinnedRunImage, startIsolatedRun } from "../support/IsolatedRun.ts";

const TIMEOUT = 600_000;
const FIXTURE_PORT = 8080;
const IPV4_ADDRESS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Letters only, so they can be searched for in what comes back.
const PLAIN_BODY = "plainfixturebody";
const MUTATED_BODY = "mutatedfixturebody";
const BODY_CHANGED: ResponseRewrite = {
    name: "body-changed",
    find: PLAIN_BODY,
    replace: MUTATED_BODY,
};
const FIXTURE_SERVICE = "rewrite-fixture";

const fixtureServerScript = `
  require('node:http').createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end(${JSON.stringify(PLAIN_BODY)});
  }).listen(${FIXTURE_PORT}, '0.0.0.0', () => console.log('listening'));`;

type ProxiedAnswer = { readonly status: number; readonly body: string };

// Asks the run's proxy for a URL, from inside the run container, and prints the answer.
const throughProxy = (url: string): string => `
  const proxy = new URL(process.env.SERVICE_PROXY);
  const target = new URL(${JSON.stringify(url)});
  const outgoing = require('node:http').request({ host: proxy.hostname, port: proxy.port, path: target.href, headers: { host: target.host } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })));
  });
  outgoing.on('error', (error) => { console.error(error.message); process.exit(1); });
  outgoing.end();`;

let fixtureName: string | undefined;
let fixtureOrigin: string;

before(
    async () => {
        const image = await pinnedRunImage();
        const name = `${PRODUCT.name}-rewrite-fixture-${randomBytes(6).toString("hex")}`;
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
            fixtureServerScript,
        ]);
        assert.equal(started.status, 0, `the fixture server did not start: ${started.stderr}`);
        fixtureName = name;
        for (
            let tries = 0;
            tries < 50 && !(await runDocker(["logs", name])).stdout.includes("listening");
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
        fixtureOrigin = `http://${address}:${FIXTURE_PORT}`;
    },
    { timeout: TIMEOUT },
);

after(
    async () => {
        if (fixtureName !== undefined) {
            await runDocker(["stop", "--time", "1", fixtureName]);
        }
    },
    { timeout: TIMEOUT },
);

// Runs once with this policy, asks the proxy for the fixture's page, and gives back the answer and
// what the handle read back.
async function askFixtureUnder(
    policy: EgressPolicy,
): Promise<{ readonly answer: ProxiedAnswer; readonly applied: readonly AppliedRewrite[] }> {
    const run = await startIsolatedRun({
        policy,
        services: [declaredService(FIXTURE_SERVICE, fixtureOrigin, true)],
    });
    try {
        const answer = (await jsonInside(
            run.handle,
            throughProxy(`${fixtureOrigin}/`),
        )) as ProxiedAnswer;
        await run.handle.exec(["true"]);
        return { answer, applied: run.handle.rewritesApplied() };
    } finally {
        await run.stop();
    }
}

const mutatedPolicy = (): EgressPolicy =>
    egressPolicy({
        allowOrigins: [fixtureOrigin],
        allowServices: [FIXTURE_SERVICE],
        fixtureOrigins: [fixtureOrigin],
        responseRewrites: [{ origin: fixtureOrigin, rewrite: BODY_CHANGED }],
    });
const plainPolicy = (): EgressPolicy =>
    egressPolicy({ allowOrigins: [fixtureOrigin], allowServices: [FIXTURE_SERVICE] });

function manifestWith(applied: readonly AppliedRewrite[]) {
    const parsed = defaultParser()(signupPlan());
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const target = testProject().matrix[0];
    assert.ok(target !== undefined);
    const adapter: AdapterInfo = {
        id: "cdp",
        version: "0.1.0",
        protocol: "Chrome DevTools Protocol (raw WebSocket)",
    };
    return buildManifest({
        plan: parsed.value,
        target,
        adapter,
        browser: { name: "chromium", version: "156.0.8078.47" },
        seed: 42,
        fixedTimeMilliseconds: Date.UTC(2026, 10, 1, 9, 0, 0),
        fixtures: [],
        host: { platform: "linux", arch: "x64" },
        responseRewrites: applied,
    });
}

test(
    "a mutated container run reads back the rewrite its proxy applied, and its manifest differs from a plain run's",
    { timeout: TIMEOUT },
    async () => {
        const mutated = await askFixtureUnder(mutatedPolicy());
        assert.deepEqual(
            mutated.answer,
            { status: 200, body: MUTATED_BODY },
            "the proxy changed what the fixture sent",
        );
        assert.deepEqual(mutated.applied, [
            { origin: origin(fixtureOrigin), name: BODY_CHANGED.name },
        ]);

        const plain = await askFixtureUnder(plainPolicy());
        assert.deepEqual(
            plain.answer,
            { status: 200, body: PLAIN_BODY },
            "the counter-example: with no rewrite, the fixture's own body comes back",
        );
        assert.deepEqual(plain.applied, []);

        assert.deepEqual(manifestWith(mutated.applied).responseRewrites, [
            { origin: fixtureOrigin, name: BODY_CHANGED.name },
        ]);
        assert.ok(!Object.hasOwn(manifestWith(plain.applied), "responseRewrites"));
        assert.notEqual(
            manifestHash(manifestWith(mutated.applied)),
            manifestHash(manifestWith(plain.applied)),
        );
    },
);

// The decisions the handle holds for the one undeclared origin these tests ask for.
const decisionsOf = (handle: RunnerHandle) =>
    handle.proxyDecisions().filter((decision) => decision.origin === "http://undeclared.invalid");

test(
    "the decisions already read survive the proxy's container stopping, and a file not yet written reads as no lines",
    { timeout: TIMEOUT },
    async () => {
        const run = await startIsolatedRun();
        try {
            await run.handle.exec(["true"]);
            assert.deepEqual(
                run.handle.proxyDecisions(),
                [],
                "the counter-example: a fresh proxy has written no file, which reads as no lines",
            );

            const answer = (await jsonInside(
                run.handle,
                throughProxy("http://undeclared.invalid/"),
            )) as ProxiedAnswer;
            assert.equal(answer.status, 403);
            await run.handle.exec(["true"]);
            const blocked = [{ origin: "http://undeclared.invalid", decision: "blocked" }];
            assert.deepEqual(decisionsOf(run.handle), blocked);

            const killed = await runDocker(["kill", `${run.handle.runId}-proxy`]);
            assert.equal(
                killed.status,
                0,
                `the proxy's container was not stopped: ${killed.stderr}`,
            );
            await run.handle.exec(["true"]);
            assert.deepEqual(decisionsOf(run.handle), blocked, "a failed read keeps what was read");
            assert.ok(
                run.handle
                    .egressEvents()
                    .some(
                        (event) =>
                            event.origin === "http://undeclared.invalid" &&
                            event.decision === "blocked",
                    ),
                JSON.stringify(run.handle.egressEvents()),
            );
        } finally {
            await run.stop();
        }
        assert.deepEqual(
            decisionsOf(run.handle),
            [{ origin: "http://undeclared.invalid", decision: "blocked" }],
            "stopping the run does not lose them either",
        );
    },
);
