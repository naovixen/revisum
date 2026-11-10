// A declared name may lead to a private address, such as an internal staging site, but a name's class
// is fixed by its first lookup. An attacker's DNS could otherwise point a declared public name into
// the customer's network mid-run. A name that really moves between classes mid-run is refused too.
// Names resolve through a fake resolver, and every allowed connection goes to a stand-in server.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import {
    connectThroughProxy,
    getThroughProxy,
    startUpstream,
    type Upstream,
} from "../support/GetThroughProxy.ts";
import { fakeResolver } from "../examples/DeclaredService.ts";

const PUBLIC_ADDRESS = "93.184.215.14";
const OTHER_PUBLIC_ADDRESS = "93.184.215.15";
const PRIVATE_ADDRESS = "10.0.0.5";
const OTHER_PRIVATE_ADDRESS = "10.0.0.6";
const SERVICE_CLIENT = { client: "service" } as const;

const NAME_ANSWERS = {
    "public-to-private.test": [[PUBLIC_ADDRESS], [PRIVATE_ADDRESS]],
    "public-to-loopback.test": [[PUBLIC_ADDRESS], ["127.0.0.1"]],
    "private-to-public.test": [[PRIVATE_ADDRESS], [PUBLIC_ADDRESS]],
    "stays-public.test": [[PUBLIC_ADDRESS], [OTHER_PUBLIC_ADDRESS]],
    "stays-private.test": [[PRIVATE_ADDRESS], [OTHER_PRIVATE_ADDRESS]],
    "tunnel-moves.test": [[PUBLIC_ADDRESS], [PRIVATE_ADDRESS]],
    "private-then-public-beside-it.test": [[PRIVATE_ADDRESS], [PRIVATE_ADDRESS, PUBLIC_ADDRESS]],
    "public-beside-private-at-first.test": [[PUBLIC_ADDRESS, PRIVATE_ADDRESS]],
    "private-beside-public-at-first.test": [[PRIVATE_ADDRESS, PUBLIC_ADDRESS]],
    "tunnel-mixed-at-first.test": [[PUBLIC_ADDRESS, PRIVATE_ADDRESS]],
};

const NAMES = Object.keys(NAME_ANSWERS);
const ORIGINS = NAMES.flatMap((name) => [`http://${name}`, `https://${name}`]);

let upstream: Upstream;
let proxy: EgressProxy;

before(async () => {
    upstream = await startUpstream();
    proxy = await startedProxyServer(
        { allowedOrigins: ORIGINS, privateOrigins: ORIGINS, rewrites: [] },
        {
            ...SERVICE_CLIENT,
            resolve: fakeResolver(NAME_ANSWERS).resolve,
            connect: (address, port) => upstream.connect(address, port),
        },
    );
});
after(async () => {
    await proxy.close();
    await upstream.close();
});

const decisionsOf = (origin: string): readonly string[] =>
    proxy
        .decisions()
        .filter((entry) => entry.origin === origin)
        .map((entry) => entry.decision);

describe("Using the egress proxy", () => {
    for (const { name, first, later } of [
        { name: "public-to-private.test", first: PUBLIC_ADDRESS, later: "a private one" },
        { name: "public-to-loopback.test", first: PUBLIC_ADDRESS, later: "a loopback one" },
        { name: "private-to-public.test", first: PRIVATE_ADDRESS, later: "a public one" },
        {
            name: "private-then-public-beside-it.test",
            first: PRIVATE_ADDRESS,
            later: "a public one beside a private one",
        },
    ]) {
        describe(`given the declared name ${name}, first at ${first}`, () => {
            describe("when the first request asks for it", () => {
                test("then it should connect to that address", async () => {
                    const answer = await getThroughProxy(proxy.url, `http://${name}/`);
                    assert.equal(answer.status, 200);
                    assert.deepEqual(upstream.dialled.at(-1), { address: first, port: 80 });
                });

                describe(`and a later lookup finds ${later}`, () => {
                    test("then it should refuse, connect to nothing, and record the block", async () => {
                        const dialledBefore = upstream.dialled.length;
                        const answer = await getThroughProxy(proxy.url, `http://${name}/`);
                        assert.equal(answer.status, 403);
                        assert.equal(upstream.dialled.length, dialledBefore);
                        assert.deepEqual(decisionsOf(`http://${name}`), ["allowed", "blocked"]);
                    });
                });
            });
        });
    }

    describe("given a tunnelled name that moves from public to private", () => {
        describe("when the first tunnel opens and a later one finds the private address", () => {
            test("then it should open the first, refuse the second, and record both", async () => {
                const authority = "tunnel-moves.test:443";
                assert.equal(await connectThroughProxy(proxy.url, authority), 200);
                const dialledBefore = upstream.dialled.length;
                assert.equal(await connectThroughProxy(proxy.url, authority), 403);
                assert.equal(upstream.dialled.length, dialledBefore);
                assert.deepEqual(decisionsOf(authority), ["allowed", "blocked"]);
            });
        });
    });

    for (const { name, order } of [
        { name: "public-beside-private-at-first.test", order: "a public address first" },
        { name: "private-beside-public-at-first.test", order: "a private address first" },
    ]) {
        describe(`given the declared name ${name}, whose first lookup finds ${order} and the other class beside it`, () => {
            describe("when the first request asks for it", () => {
                test("then it should refuse, connect to nothing, and record the block", async () => {
                    const dialledBefore = upstream.dialled.length;
                    const answer = await getThroughProxy(proxy.url, `http://${name}/`);
                    assert.equal(answer.status, 403);
                    assert.equal(upstream.dialled.length, dialledBefore);
                    assert.deepEqual(decisionsOf(`http://${name}`), ["blocked"]);
                });
            });
        });
    }

    describe("given a tunnelled name whose first lookup finds public and private addresses together", () => {
        describe("when the first tunnel opens", () => {
            test("then it should refuse, connect to nothing, and record the block", async () => {
                const authority = "tunnel-mixed-at-first.test:443";
                const dialledBefore = upstream.dialled.length;
                assert.equal(await connectThroughProxy(proxy.url, authority), 403);
                assert.equal(upstream.dialled.length, dialledBefore);
                assert.deepEqual(decisionsOf(authority), ["blocked"]);
            });
        });
    });

    for (const { name, addresses, condition } of [
        {
            name: "stays-public.test",
            addresses: [PUBLIC_ADDRESS, OTHER_PUBLIC_ADDRESS],
            condition: "another public address",
        },
        {
            name: "stays-private.test",
            addresses: [PRIVATE_ADDRESS, OTHER_PRIVATE_ADDRESS],
            condition: "another private address",
        },
    ]) {
        describe(`given the declared name ${name}, which moves to ${condition}`, () => {
            describe("when two requests ask for it", () => {
                test("then it should connect to each address, so a refusal above means something", async () => {
                    const dialledBefore = upstream.dialled.length;
                    assert.equal((await getThroughProxy(proxy.url, `http://${name}/`)).status, 200);
                    assert.equal((await getThroughProxy(proxy.url, `http://${name}/`)).status, 200);
                    assert.deepEqual(
                        upstream.dialled.slice(dialledBefore).map((dialled) => dialled.address),
                        addresses,
                    );
                });
            });
        });
    }
});
