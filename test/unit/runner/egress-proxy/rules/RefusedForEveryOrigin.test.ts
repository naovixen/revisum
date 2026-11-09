// Some addresses stay out of reach whatever an origin is declared as. All of link-local is refused,
// because the metadata services of ECS, EKS and GCP live there at several addresses, and so are the
// other clouds' named ones. A private service may reach every other private address, and the addresses
// just outside each refused edge are the counter-examples.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { checkResolvedAddress, type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import { getThroughProxy, startUpstream, type Upstream } from "../../support/GetThroughProxy.ts";
import { fakeResolver } from "../../examples/DeclaredService.ts";

const LINK_LOCAL_IPV4 = [
    "169.254.0.0",
    "169.254.0.1",
    "169.254.169.254",
    "169.254.170.2",
    "169.254.170.23",
    "169.254.255.255",
];
const LINK_LOCAL_IPV6 = ["fe80::1", "FE80::1", "fe80::1%eth0", "febf::1"];
const NAMED_METADATA = ["168.63.129.16", "fd20:ce::254", "fd00:ec2::254", "100.100.100.200"];
const CARRYING_IPV4_INSIDE = [
    "::ffff:169.254.170.2",
    "::169.254.170.2",
    "64:ff9b::169.254.170.2",
    "2002:a9fe:aa02::1",
    "::ffff:168.63.129.16",
    "::168.63.129.16",
    "64:ff9b::168.63.129.16",
    "2002:a83f:8110::1",
];
const REFUSED_FOR_EVERY_ORIGIN = [
    ...LINK_LOCAL_IPV4,
    ...LINK_LOCAL_IPV6,
    ...NAMED_METADATA,
    ...CARRYING_IPV4_INSIDE,
];

const ALLOWED_TO_A_PRIVATE_SERVICE = [
    "10.0.0.5",
    "127.0.0.1",
    "192.168.1.1",
    "::1",
    "fd12:3456::1",
    "169.253.255.255",
    "169.255.0.0",
    "168.63.129.15",
    "168.63.129.17",
    "fd20:ce::253",
    "fd20:ce::255",
    "fe7f:ffff::1",
    "fec0::1",
];
const ALLOWED_TO_ANY_ORIGIN = ["168.63.129.15", "168.63.129.17", "169.253.255.255", "169.255.0.0"];

const SERVICE_CLIENT = { client: "service" } as const;
const LINK_LOCAL_APP = "link-local-app.test";

describe("Using the address check", () => {
    for (const address of REFUSED_FOR_EVERY_ORIGIN) {
        describe(`given the address ${address}`, () => {
            describe("when a private service resolves to it", () => {
                test("then it should refuse it", () => {
                    assert.equal(
                        checkResolvedAddress(address, { privateService: true }),
                        "refused",
                    );
                });
            });

            describe("when any other origin resolves to it", () => {
                test("then it should refuse it", () => {
                    assert.equal(checkResolvedAddress(address), "refused");
                });
            });
        });
    }

    for (const address of ALLOWED_TO_A_PRIVATE_SERVICE) {
        describe(`given the address ${address}, outside those refused for every origin`, () => {
            describe("when a private service resolves to it", () => {
                test("then it should allow it", () => {
                    assert.equal(
                        checkResolvedAddress(address, { privateService: true }),
                        "allowed",
                    );
                });
            });
        });
    }

    for (const address of ALLOWED_TO_ANY_ORIGIN) {
        describe(`given the public address ${address}, beside a refused edge`, () => {
            describe("when any origin resolves to it", () => {
                test("then it should allow it", () => {
                    assert.equal(checkResolvedAddress(address), "allowed");
                });
            });
        });
    }
});

describe("Using the egress proxy", () => {
    describe("given a private origin whose name resolves to a link-local address", () => {
        let upstream: Upstream;
        let proxy: EgressProxy;
        before(async () => {
            upstream = await startUpstream();
            const origin = `http://${LINK_LOCAL_APP}`;
            proxy = await startedProxyServer(
                { allowedOrigins: [origin], privateOrigins: [origin], rewrites: [] },
                {
                    ...SERVICE_CLIENT,
                    resolve: fakeResolver({ [LINK_LOCAL_APP]: ["169.254.170.2"] }).resolve,
                    connect: (address, port) => upstream.connect(address, port),
                },
            );
        });
        after(async () => {
            await proxy.close();
            await upstream.close();
        });

        describe("when a request asks for it", () => {
            test("then it should refuse, connect to nothing, and record the block", async () => {
                const answer = await getThroughProxy(proxy.url, `http://${LINK_LOCAL_APP}/`);
                assert.equal(answer.status, 403);
                assert.deepEqual(upstream.dialled, []);
                assert.deepEqual(proxy.decisions(), [
                    { origin: `http://${LINK_LOCAL_APP}`, decision: "blocked" },
                ]);
            });
        });
    });
});
