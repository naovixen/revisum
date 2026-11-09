// How an isolated run's one proxy refuses, and what the run says about it, on real Docker.
//   - The browser and whatever calls services share a run container and a proxy. A page in a worker
//     must not be able to read a refusal as content, and a service call must keep its answer, which
//     says whose refusal it was. Their requests look alike, so each has an address of its own: the
//     browser's is HTTP_PROXY, as a browser takes that by default, and the service's is SERVICE_PROXY.
//     A declared request is carried through both, the counter-example that makes a closed socket
//     mean something.
//   - A run's blocked origins hold the proxy's refusals, though the proxy is in another container, and
//     one refused in two forms appears once. The list is in the result's hash, so it has to be whole
//     by the time the run inside the container builds that result.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { PRODUCT } from "@revisum/contracts";
import { runDocker } from "@revisum/runner";
import { plainRequestText, tunnelRequestText } from "../../unit/runner/support/GetThroughProxy.ts";
import { declaredService, egressPolicy } from "../../unit/runner/examples/DeclaredService.ts";
import { createCleanUpScope } from "../../support/CleanUpScope.ts";
import { jsonInside, pinnedRunImage, startIsolatedRun, type IsolatedRun } from "../support/IsolatedRun.ts";
import {
    REFUSED_BY_BOTH_HOST,
    REFUSED_PLAIN_ORIGIN,
    REFUSED_SECURE_HOST,
    WHAT_A_CLOSED_SOCKET_LOOKS_LIKE,
    runBrowserPastRefusalsInside,
    type RunPastRefusals,
} from "../support/RunBrowserPastRefusalsInside.ts";

const TIMEOUT = 600_000;
const FIXTURE_PORT = 8080;
const FIXTURE_SERVICE = "declared-fixture";
// Letters only, so it can be searched for in what comes back.
const FIXTURE_BODY = "declaredfixturebody";
const IPV4_ADDRESS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const BROWSER_ADDRESS = "HTTP_PROXY";
const SERVICE_ADDRESS = "SERVICE_PROXY";
const NO_SUCH_ADDRESS = "the run container has no such address";
const UNDECLARED_PLAIN_ORIGIN = "http://undeclared.invalid";
const UNDECLARED_AUTHORITY = "undeclared.invalid:443";

const fixtureServerScript = `
  require('node:http').createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end(${JSON.stringify(FIXTURE_BODY)});
  }).listen(${FIXTURE_PORT}, '0.0.0.0', () => console.log('listening'));`;

// Sends the proxy's address the request as written, and prints all it got before the socket closed.
const exchangeThrough = (addressVariable: string, requestText: string): string => `
  const address = process.env[${JSON.stringify(addressVariable)}];
  if (address === undefined) { console.log(JSON.stringify(${JSON.stringify(NO_SUCH_ADDRESS)})); process.exit(0); }
  const proxy = new URL(address);
  let received = '';
  const socket = require('node:net').connect({ host: proxy.hostname, port: Number(proxy.port) }, () => socket.write(${JSON.stringify(requestText)}));
  socket.on('data', (chunk) => { received += chunk; });
  socket.on('error', () => undefined);
  socket.on('close', () => { console.log(JSON.stringify(received)); process.exit(0); });`;

const cleanUps = createCleanUpScope();
let fixtureOrigin: string;
let run: IsolatedRun;

before(
    async () => {
        const image = await pinnedRunImage();
        const name = `${PRODUCT.name}-refusals-fixture-${randomBytes(6).toString("hex")}`;
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
        cleanUps.add(() => runDocker(["stop", "--time", "1", name]));
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
        assert.match(address, IPV4_ADDRESS, `no bridge address: ${inspected.stderr}`);
        fixtureOrigin = `http://${address}:${FIXTURE_PORT}`;
        run = await startIsolatedRun({
            inputs: ["test"],
            policy: egressPolicy({
                allowOrigins: [fixtureOrigin],
                allowServices: [FIXTURE_SERVICE],
            }),
            services: [declaredService(FIXTURE_SERVICE, fixtureOrigin, true)],
        });
        cleanUps.add(() => run.stop());
    },
    { timeout: TIMEOUT },
);

after(() => cleanUps.runAll(), { timeout: TIMEOUT });

const exchange = async (addressVariable: string, requestText: string): Promise<string> => {
    const received = await jsonInside(run.handle, exchangeThrough(addressVariable, requestText));
    assert.equal(typeof received, "string");
    return String(received);
};

describe("Using an isolated run on real Docker", () => {
    describe("given the address a browser in the run container uses", () => {
        describe("when a plain request asks for an undeclared origin", () => {
            test(
                "then it should close the socket with nothing on it",
                { timeout: TIMEOUT },
                async () => {
                    assert.equal(
                        await exchange(BROWSER_ADDRESS, plainRequestText(UNDECLARED_PLAIN_ORIGIN)),
                        "",
                    );
                },
            );
        });

        describe("when a tunnel asks for an undeclared origin", () => {
            test(
                "then it should close the socket with nothing on it",
                { timeout: TIMEOUT },
                async () => {
                    assert.equal(
                        await exchange(BROWSER_ADDRESS, tunnelRequestText(UNDECLARED_AUTHORITY)),
                        "",
                    );
                },
            );
        });

        describe("when a plain request asks for a declared origin", () => {
            test("then it should pass the answer on", { timeout: TIMEOUT }, async () => {
                const received = await exchange(BROWSER_ADDRESS, plainRequestText(fixtureOrigin));
                assert.match(received, /^HTTP\/1\.1 200/);
                assert.ok(received.includes(FIXTURE_BODY), received);
            });
        });
    });

    describe("given the address service calls in the run container use", () => {
        describe("when a plain request asks for an undeclared origin", () => {
            let received: string;
            before(
                async () => {
                    received = await exchange(
                        SERVICE_ADDRESS,
                        plainRequestText(UNDECLARED_PLAIN_ORIGIN),
                    );
                },
                { timeout: TIMEOUT },
            );

            test("then it should answer 403", () => {
                assert.match(received, /^HTTP\/1\.1 403/);
            });

            test("then it should mark the answer as the proxy's refusal", () => {
                assert.match(received, /x-egress-decision: blocked/i);
            });
        });

        describe("when a tunnel asks for an undeclared origin", () => {
            test("then it should answer 403", { timeout: TIMEOUT }, async () => {
                assert.match(
                    await exchange(SERVICE_ADDRESS, tunnelRequestText(UNDECLARED_AUTHORITY)),
                    /^HTTP\/1\.1 403/,
                );
            });
        });

        describe("when a plain request asks for a declared origin", () => {
            test("then it should pass the answer on", { timeout: TIMEOUT }, async () => {
                const received = await exchange(SERVICE_ADDRESS, plainRequestText(fixtureOrigin));
                assert.match(received, /^HTTP\/1\.1 200/);
                assert.ok(received.includes(FIXTURE_BODY), received);
            });
        });
    });

    describe("given a plan on a page whose shared worker asks for undeclared origins", () => {
        describe("when it runs through the driver in the run container", () => {
            let outcome: RunPastRefusals;
            before(
                async () => {
                    outcome = await runBrowserPastRefusalsInside(run.handle);
                },
                { timeout: TIMEOUT },
            );

            test("then it should let the worker hear only a network error", () => {
                assert.equal(
                    outcome.state,
                    "Passed",
                    `the plan wanted "${WHAT_A_CLOSED_SOCKET_LOOKS_LIKE}": ${JSON.stringify(outcome.observedOnFailure)}`,
                );
            });

            test("then it should list what the proxy refused, each once", () => {
                assert.deepEqual(outcome.blockedOrigins, [
                    REFUSED_PLAIN_ORIGIN,
                    `https://${REFUSED_BY_BOTH_HOST}`,
                    `${REFUSED_SECURE_HOST}:443`,
                ]);
            });
        });
    });
});
