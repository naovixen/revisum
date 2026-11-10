// The Docker engine's side of the isolation probe, with no Docker: the spawn of the Docker client is
// replaced, so each test decides what Docker prints. Replacing it on the module's CommonJS exports and
// syncing the built-in ES module bindings reaches the engine's own import.
//   - networkGatewayAddress reads Docker's description of the network: the first address of its IPv4
//     subnet, null when a container on the network holds that address, and a problem when the network
//     cannot be read;
//   - probeEgress's script really runs, in Node, against a loopback port with nothing listening: a
//     refused connection is reached only for a target that counts a refusal.
import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { dockerCliEngine, type ContainerEngine } from "@revisum/runner";

const NETWORK = "run-network";

// ---- The Docker client, replaced ---------------------------------------------------------------------

const originalSpawn: typeof childProcess.spawn = childProcess.spawn;

afterEach(() => {
    Reflect.set(childProcess, "spawn", originalSpawn);
    syncBuiltinESMExports();
});

type DockerAnswer = { readonly status: number; readonly stdout: string; readonly stderr?: string };

// A child process that prints the answer and closes, as far as the engine reads one.
function printingChild(answer: DockerAnswer): EventEmitter {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => true });
    setImmediate(() => {
        stdout.emit("data", Buffer.from(answer.stdout, "utf8"));
        stderr.emit("data", Buffer.from(answer.stderr ?? "", "utf8"));
        child.emit("close", answer.status);
    });
    return child;
}

// Every call of the Docker client gets this answer; the argument lists it was called with are kept.
function dockerPrints(answer: DockerAnswer): readonly (readonly string[])[] {
    const lines: (readonly string[])[] = [];
    Reflect.set(childProcess, "spawn", (_command: unknown, words: readonly string[]) => {
        lines.push(words);
        return printingChild(answer);
    });
    syncBuiltinESMExports();
    return lines;
}

// The Docker client cannot start at all.
function dockerCannotStart(): void {
    Reflect.set(childProcess, "spawn", () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => true,
        });
        setImmediate(() => child.emit("error", new Error("spawn docker ENOENT")));
        return child;
    });
    syncBuiltinESMExports();
}

// `docker exec` runs its command here, in Node, in place of a container.
function execRunsHere(): void {
    Reflect.set(
        childProcess,
        "spawn",
        (_command: unknown, words: readonly string[], options: SpawnOptions) => {
            const [, , , ...nodeArguments] = words;
            return originalSpawn(process.execPath, nodeArguments, options);
        },
    );
    syncBuiltinESMExports();
}

const gatewayAddress = (engine: ContainerEngine) => {
    const read = engine.networkGatewayAddress;
    return read(NETWORK);
};

// Docker's description of a network, reduced to the fields that matter here.
const description = (fields: {
    readonly subnets?: readonly string[];
    readonly members?: readonly string[];
}): string =>
    JSON.stringify({
        Name: NETWORK,
        IPAM: {
            Driver: "default",
            Config: (fields.subnets ?? []).map((subnet) => ({ Subnet: subnet })),
        },
        Containers: Object.fromEntries(
            (fields.members ?? []).map((address, index) => [
                `container-${index}`,
                { Name: `member-${index}`, IPv4Address: address, IPv6Address: "" },
            ]),
        ),
    });

const prints = (stdout: string): DockerAnswer => ({ status: 0, stdout });

// ---- Where a gateway would be -------------------------------------------------------------------------

test("Docker is asked for that network's whole description, as JSON", async () => {
    const lines = dockerPrints(prints(description({ subnets: ["172.18.0.0/16"] })));
    await gatewayAddress(dockerCliEngine());
    assert.deepEqual(lines, [["network", "inspect", "--format", "{{json .}}", NETWORK]]);
});

const FIRST_ADDRESSES: readonly { readonly subnet: string; readonly first: string }[] = [
    { subnet: "172.18.0.0/16", first: "172.18.0.1" },
    { subnet: "10.1.2.128/25", first: "10.1.2.129" },
    { subnet: "192.168.5.0/24", first: "192.168.5.1" },
    { subnet: "192.168.5.7/24", first: "192.168.5.1" },
];

for (const { subnet, first } of FIRST_ADDRESSES) {
    test(`on an empty network with the subnet ${subnet}, the place to try is ${first}`, async () => {
        dockerPrints(prints(description({ subnets: [subnet] })));
        assert.deepEqual(await gatewayAddress(dockerCliEngine()), { ok: true, value: first });
    });
}

test("when a container on the network holds the subnet's first address, there is nothing to try", async () => {
    dockerPrints(
        prints(
            description({
                subnets: ["172.18.0.0/16"],
                members: ["172.18.0.2/16", "172.18.0.1/16"],
            }),
        ),
    );
    assert.deepEqual(await gatewayAddress(dockerCliEngine()), { ok: true, value: null });
});

test("counter-example: containers on other addresses leave the first address to try", async () => {
    dockerPrints(
        prints(
            description({
                subnets: ["172.18.0.0/16"],
                members: ["172.18.0.2/16", "172.18.0.10/16", "172.18.1.1/16"],
            }),
        ),
    );
    assert.deepEqual(await gatewayAddress(dockerCliEngine()), { ok: true, value: "172.18.0.1" });
});

test("an IPv6 pool listed first does not hide the network's IPv4 subnet", async () => {
    dockerPrints(prints(description({ subnets: ["fd00::/64", "172.18.0.0/16"] })));
    assert.deepEqual(await gatewayAddress(dockerCliEngine()), { ok: true, value: "172.18.0.1" });
});

test("a description that lists no containers still gives the first address to try", async () => {
    dockerPrints(prints(JSON.stringify({ IPAM: { Config: [{ Subnet: "172.18.0.0/16" }] } })));
    assert.deepEqual(await gatewayAddress(dockerCliEngine()), { ok: true, value: "172.18.0.1" });
});

// ---- A network it cannot read ----------------------------------------------------------------------------

const UNREADABLE: readonly { readonly title: string; readonly answer: DockerAnswer }[] = [
    {
        title: "Docker cannot find the network",
        answer: { status: 1, stdout: "", stderr: `Error: No such network: ${NETWORK}` },
    },
    { title: "Docker prints something other than JSON", answer: prints("not json") },
    {
        title: "the description has no address pools section",
        answer: prints(JSON.stringify({ Name: NETWORK })),
    },
    {
        title: "the address pools are not a list",
        answer: prints(JSON.stringify({ IPAM: { Config: null } })),
    },
];

for (const { title, answer } of UNREADABLE) {
    test(`a problem is reported when ${title}`, async () => {
        dockerPrints(answer);
        const read = await gatewayAddress(dockerCliEngine());
        assert.equal(read.ok, false, JSON.stringify(read));
    });
}

test("a problem is reported when the Docker client cannot start", async () => {
    dockerCannotStart();
    const read = await gatewayAddress(dockerCliEngine());
    assert.equal(read.ok, false, JSON.stringify(read));
});

// Null means a container holds the first address, which Docker does only for a network with no
// gateway. A description with no IPv4 subnet shows no such thing, so it is a network not read: as
// null it would drop the gateway from the probe, and an unknown would be taken for blocked.
const NO_READABLE_SUBNET: readonly {
    readonly title: string;
    readonly pools: readonly unknown[];
}[] = [
    { title: "an empty list of address pools", pools: [] },
    { title: "a pool with no subnet", pools: [{ Gateway: "172.18.0.1" }] },
    { title: "a subnet that is not an address range", pools: [{ Subnet: "not a subnet" }] },
    { title: "only an IPv6 subnet", pools: [{ Subnet: "fd00::/64" }] },
];

for (const { title, pools } of NO_READABLE_SUBNET) {
    test(`a problem is reported, not "nothing to try", for a description with ${title}`, async () => {
        dockerPrints(prints(JSON.stringify({ IPAM: { Config: pools }, Containers: {} })));
        const read = await gatewayAddress(dockerCliEngine());
        assert.equal(read.ok, false, JSON.stringify(read));
    });
}

// ---- The probe's script, really run ---------------------------------------------------------------------

// A loopback port with nothing listening: it was just free, and stays closed for the test.
async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address: AddressInfo | string | null = server.address();
    assert.ok(typeof address === "object" && address !== null, "the server has a port");
    await new Promise((resolve) => {
        server.close(resolve);
    });
    return address.port;
}

test(
    "the probe counts a refused connection as reached for a target that says so",
    { timeout: 30_000 },
    async () => {
        const port = await closedPort();
        execRunsHere();
        assert.equal(
            await dockerCliEngine().probeEgress("run-container", [
                { host: "127.0.0.1", port, refusalCountsAsReached: true },
            ]),
            "reached",
        );
    },
);

test(
    "counter-example: the probe counts a refused connection as blocked for any other target",
    { timeout: 30_000 },
    async () => {
        const port = await closedPort();
        execRunsHere();
        assert.equal(
            await dockerCliEngine().probeEgress("run-container", [{ host: "127.0.0.1", port }]),
            "blocked",
        );
    },
);

test(
    "the probe counts an accepted connection as reached for a target that does not count refusals",
    { timeout: 30_000 },
    async () => {
        const server = createServer((socket) => {
            socket.destroy();
        });
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        try {
            const address: AddressInfo | string | null = server.address();
            assert.ok(typeof address === "object" && address !== null, "the server has a port");
            execRunsHere();
            assert.equal(
                await dockerCliEngine().probeEgress("run-container", [
                    { host: "127.0.0.1", port: address.port },
                ]),
                "reached",
            );
        } finally {
            await new Promise((resolve) => {
                server.close(resolve);
            });
        }
    },
);
