// The container engine port, and its Docker implementation. The runner asks the engine for what
// it needs (an image's id, a network, a hardened container, a command run inside one), so unit
// tests can answer with a fake. Docker is driven through its command-line client, started with
// spawn and never through a shell, so no argument is ever read as shell syntax; no Docker library
// is needed.
import { failure, success, type ExecOutcome, type Result } from "@revisum/contracts";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export const MountKind = {
    Folder: "folder",
    File: "file",
    Volume: "volume",
} as const;

export type MountKind = (typeof MountKind)[keyof typeof MountKind];

// A host folder, a single host file or a named volume, mounted read-only unless `writable` says
// otherwise. Only a workload's output folder is ever writable.
export type ContainerMount = {
    readonly kind: MountKind;
    readonly source: string;
    readonly target: string;
    readonly writable?: true;
};

// A container to start. Every container the engine starts is also hardened the same way: no
// capabilities, no way to gain privileges, a read-only root file system with a private /tmp.
export type ContainerOptions = {
    readonly name: string;
    // The image, by id ("sha256:…").
    readonly image: string;
    // The networks it joins. It is attached to all of them before its command starts.
    readonly networks: readonly string[];
    readonly user: string;
    // The host path of the seccomp profile it runs under.
    readonly seccompProfile: string;
    readonly workingFolder: string;
    // Its whole environment: nothing else is passed from the host.
    readonly environment: Readonly<Record<string, string>>;
    readonly mounts: readonly ContainerMount[];
    readonly command: readonly string[];
    // Replaces the image's own entrypoint, so only Revisum's command starts the container.
    readonly entrypoint?: string;
    // The name servers its lookups are forwarded to, by address. Docker's own resolver still answers
    // for the containers on its networks first.
    readonly dns?: readonly string[];
    // Host names its own lookups answer with a fixed address, before any name server is asked, such
    // as a declared service's name mapped to the proxy that relays to it.
    readonly hosts?: readonly HostEntry[];
};

export type HostEntry = { readonly name: string; readonly address: string };

export type EngineProblem = { readonly detail: string };

// What a command printed, and how it ended. isOutputCutShort: more was printed than could be kept, so
// what is here is only the start of it and nothing may be read from it as complete.
export type ContainerExecOutcome = ExecOutcome & { readonly isOutputCutShort?: true };

export const OUTPUT_CUT_SHORT_DETAIL = "the command printed more than can be read back whole";

// internal-refused: Docker said it cannot make a network with no route out, so an ordinary one may
// be tried instead. failed: any other reason, which says nothing about what Docker can make.
export const NetworkFailureKind = {
    InternalRefused: "internal-refused",
    Failed: "failed",
} as const;
export type NetworkFailureKind = (typeof NetworkFailureKind)[keyof typeof NetworkFailureKind];

export type NetworkFailure = { readonly kind: NetworkFailureKind; readonly detail: string };
export type ProbeTarget = {
    readonly host: string;
    readonly port: number;
    // For an address that should have nothing behind it: a refused connection still shows a machine
    // answered there, even with no service on this port. Elsewhere a refusal means not reached.
    readonly refusalCountsAsReached?: true;
};

export const ImageAnswerKind = {
    Found: "found",
    Absent: "absent",
    Unanswered: "unanswered",
} as const;

export type ImageAnswerKind = (typeof ImageAnswerKind)[keyof typeof ImageAnswerKind];

// What the engine says about an image, by reference: it has it, it has none, or it could not say.
export type ImageAnswer =
    | { readonly kind: "found"; readonly id: string }
    | { readonly kind: "absent" }
    | { readonly kind: "unanswered"; readonly problem: EngineProblem };

export interface ContainerEngine {
    // The id ("sha256:…") of the local image with this reference. A daemon that does not answer says
    // nothing about whether the image exists, so it answers 'unanswered', never 'absent'.
    imageId(reference: string): Promise<ImageAnswer>;
    // internal: a network with no route out of the host and no gateway to the Docker host.
    createNetwork(
        name: string,
        options: { readonly internal: boolean },
    ): Promise<Result<void, NetworkFailure>>;
    removeNetwork(name: string): Promise<Result<void, EngineProblem>>;
    // Where a gateway to the Docker host would be on this network, for a probe to try: the first
    // address of its IPv4 subnet. Null when there is nothing to try, because a container on the network
    // holds that address, which Docker gives out only to a network with no gateway. A problem when the
    // network cannot be read or shows no IPv4 subnet.
    networkGatewayAddress(network: string): Promise<Result<string | null, EngineProblem>>;
    // Starts a container and returns its id.
    startContainer(options: ContainerOptions): Promise<Result<string, EngineProblem>>;
    // Runs an argument vector inside a running container, without a shell. Each variable named in
    // `environmentNames` is passed by name only, so Docker copies its value from the client's own
    // environment and no secret is ever on a command line. A failure means the command never ran; any
    // exit of the command, whatever its number, is a success carrying that code. It runs for as long
    // as the command does: it is the caller who bounds it.
    exec(
        containerId: string,
        command: readonly string[],
        environmentNames?: readonly string[],
    ): Promise<Result<ContainerExecOutcome, EngineProblem>>;
    // Tries a direct connection from inside the container to each target. 'reached' when any one
    // answered, or when the probe itself could not run, so an unknown is never taken for 'blocked'.
    probeEgress(
        containerId: string,
        targets: readonly ProbeTarget[],
    ): Promise<"reached" | "blocked">;
    // Removes a container, running or not. A problem means it may still be there.
    removeContainer(containerId: string): Promise<Result<void, EngineProblem>>;
    // The user an image's containers run as by default, such as "node" or "1000:1000", or null when
    // the image has none. A problem says nothing about the user, so it is never taken for none.
    imageUser(reference: string): Promise<Result<string | null, EngineProblem>>;
    // A running container's address on one of its networks. A problem when it has none there, or when
    // Docker could not say.
    containerAddress(containerId: string, network: string): Promise<Result<string, EngineProblem>>;
}

// Output beyond this is dropped, and the outcome says so, so a chatty command cannot exhaust memory.
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
export const DOCKER_COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const PROBE_TIMEOUT_MILLISECONDS = 4_000;
// An --internal network alone keeps a gateway, through which its containers can reach a service on
// the Docker host. This takes the gateway away and leaves the network's peers connected.
const NO_GATEWAY_OPTION = "com.docker.network.bridge.inhibit_ipv4=true";

// A null status is a client ended by `signal`, as one that ran out of time is, so no exit is invented.
export type DockerOutcome = {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    // True when more was printed, on either stream, than was kept.
    readonly isOutputCutShort: boolean;
};

// True when the client exited 0 with all it printed kept: only then can its output be parsed.
export const isWholeAnswer = (outcome: DockerOutcome): boolean =>
    outcome.status === 0 && !outcome.isOutputCutShort;

const CLIENT_DID_NOT_RUN_STATUS = -1;

// Runs the Docker client with these arguments, without a shell. Status -1 means it could not run,
// whether spawn threw, no streams opened or an error came later. Values in `environment` reach the
// client through its own environment, never its command line, which other users of the host can
// read. It never rejects.
export function runDocker(
    words: readonly string[],
    timeoutMilliseconds: number | null = DOCKER_COMMAND_TIMEOUT_MILLISECONDS,
    environment: Readonly<Record<string, string>> = {},
): Promise<DockerOutcome> {
    return new Promise((resolve) => {
        let child: ChildProcessByStdio<null, Readable | null, Readable | null>;
        try {
            child = spawn("docker", [...words], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                ["env"]: { ...process.env, ...environment },
            });
        } catch (error) {
            resolve({
                status: CLIENT_DID_NOT_RUN_STATUS,
                signal: null,
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                isOutputCutShort: false,
            });
            return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let kept = 0;
        let isOutputCutShort = false;
        const keep =
            (into: Buffer[]) =>
            (chunk: Buffer): void => {
                if (kept >= OUTPUT_LIMIT_BYTES) {
                    isOutputCutShort = true;
                    return;
                }
                kept += chunk.length;
                into.push(chunk);
            };
        // Without streams, such as on a host out of file handles, spawn's error event says why.
        child.stdout?.on("data", keep(stdout));
        child.stderr?.on("data", keep(stderr));
        const timer =
            timeoutMilliseconds === null
                ? undefined
                : setTimeout(() => child.kill(), timeoutMilliseconds);
        const finish = (status: number | null, signal: NodeJS.Signals | null, extra = ""): void => {
            clearTimeout(timer);
            resolve({
                status,
                signal,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: `${Buffer.concat(stderr).toString("utf8")}${extra}`,
                isOutputCutShort,
            });
        };
        child.once("error", (error) => finish(CLIENT_DID_NOT_RUN_STATUS, null, error.message));
        child.once("close", (code, signal) => finish(code, signal));
    });
}

function problem(outcome: DockerOutcome): EngineProblem {
    if (outcome.status === 0 && outcome.isOutputCutShort) {
        return { detail: OUTPUT_CUT_SHORT_DETAIL };
    }
    const errors = outcome.stderr.trim();
    const printed = errors === "" ? outcome.stdout.trim() : errors;
    if (outcome.status !== null) {
        return { detail: printed.slice(0, 500) };
    }
    const killed = `the Docker client was killed by ${outcome.signal ?? "a signal"}`;
    return { detail: (printed === "" ? killed : `${killed}: ${printed}`).slice(0, 500) };
}

const NO_SUCH_IMAGE = /no such image/i;

// What the client prints, first, when `docker exec` could not run its command. Exit statuses cannot
// say: the client exits 1 for a container that is gone, and a command may exit 1 or even 125 for its
// own reasons. Only these words, about this container or from a client with no daemon, tell them
// apart, and a command printing them further down its output has not said them.
const clientFailureOpenings = (containerId: string): readonly string[] => [
    `Error response from daemon: No such container: ${containerId}`,
    `Error response from daemon: container ${containerId} is not running`,
    "Cannot connect to the Docker daemon at",
    "error during connect:",
    "failed to connect to the docker API at",
];

const didCommandRun = (outcome: DockerOutcome, containerId: string): boolean =>
    outcome.status !== CLIENT_DID_NOT_RUN_STATUS &&
    (outcome.status === 0 ||
        !clientFailureOpenings(containerId).some((opening) => outcome.stderr.startsWith(opening)));

// Only Docker's refusal of the options that make a network with no route out: everything else, a
// full pool or a stopped daemon, says nothing about whether such a network could be made.
const INTERNAL_NETWORK_REFUSALS: readonly RegExp[] = [
    /com\.docker\.network\.bridge\.inhibit_ipv4/,
    /\binternal\b.*\b(not supported|unsupported)\b|\b(does not support|not supported|unknown flag)\b.*\binternal\b/i,
];

const isInternalNetworkRefused = (outcome: DockerOutcome): boolean =>
    INTERNAL_NETWORK_REFUSALS.some((refusal) => refusal.test(outcome.stderr));

// A start that failed part-way, and what became of the container it rolled back.
const startProblem = (cause: DockerOutcome, removed: Result<void, EngineProblem>): EngineProblem =>
    removed.ok
        ? problem(cause)
        : {
              detail: `${problem(cause).detail}; it could not be removed afterwards: ${removed.error.detail}`,
          };

function mountArgument(mount: ContainerMount): string {
    const type = mount.kind === MountKind.Volume ? "volume" : "bind";
    return `type=${type},source=${mount.source},target=${mount.target}${mount.writable === true ? "" : ",readonly"}`;
}

// The Docker arguments that create, but do not start, a hardened container. Each variable is named
// with no value, so Docker copies it from the client's environment and no secret is on the command line.
export function createArguments(options: ContainerOptions): readonly string[] {
    const [firstNetwork = "none"] = options.networks;
    return [
        "create",
        "--name",
        options.name,
        "--network",
        firstNetwork,
        "--user",
        options.user,
        "--security-opt",
        `seccomp=${options.seccompProfile}`,
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=1024m",
        "--shm-size",
        "512m",
        "--workdir",
        options.workingFolder,
        ...(options.entrypoint === undefined ? [] : ["--entrypoint", options.entrypoint]),
        ...(options.dns ?? []).flatMap((address) => ["--dns", address]),
        ...(options.hosts ?? []).flatMap((entry) => [
            "--add-host",
            `${entry.name}:${entry.address}`,
        ]),
        ...Object.keys(options.environment).flatMap((name) => ["--env", name]),
        ...options.mounts.flatMap((mount) => ["--mount", mountArgument(mount)]),
        options.image,
        ...options.command,
    ];
}

// Prints "reached" when a direct connection to any target succeeds within the timeout, or is refused
// by a target that counts a refusal, else "blocked".
const probeScript = (targets: readonly ProbeTarget[]): string => `
  const { connect } = require('node:net');
  const targets = ${JSON.stringify(targets)};
  let open = targets.length;
  const done = (outcome) => { console.log(outcome); process.exit(0); };
  for (const target of targets) {
    const socket = connect({ host: target.host, port: target.port });
    const settle = () => { socket.destroy(); open -= 1; if (open === 0) done('blocked'); };
    socket.setTimeout(${PROBE_TIMEOUT_MILLISECONDS}, settle);
    socket.on('error', (error) => { if (target.refusalCountsAsReached === true && error.code === 'ECONNREFUSED') done('reached'); else settle(); });
    socket.on('connect', () => done('reached'));
  }
  if (open === 0) done('blocked');`;

// The container engine over the Docker command-line client.
export function dockerCliEngine(): ContainerEngine {
    const execWithin = async (
        timeoutMilliseconds: number | null,
        containerId: string,
        command: readonly string[],
        environmentNames: readonly string[] = [],
    ): Promise<Result<ContainerExecOutcome, EngineProblem>> => {
        const outcome = await runDocker(
            [
                "exec",
                ...environmentNames.flatMap((name) => ["--env", name]),
                containerId,
                ...command,
            ],
            timeoutMilliseconds,
        );
        const { status } = outcome;
        if (status === null || !didCommandRun(outcome, containerId)) {
            return failure(problem(outcome));
        }
        return success({
            exitCode: status,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            ...(outcome.isOutputCutShort ? { isOutputCutShort: true } : {}),
        });
    };
    const removeContainer = async (containerId: string): Promise<Result<void, EngineProblem>> => {
        const outcome = await runDocker(["rm", "--force", "--volumes", containerId]);
        return outcome.status === 0 ? success(undefined) : failure(problem(outcome));
    };
    return {
        async imageId(reference) {
            const outcome = await runDocker(["image", "inspect", "--format", "{{.Id}}", reference]);
            const id = outcome.stdout.trim();
            if (isWholeAnswer(outcome) && id !== "") {
                return { kind: ImageAnswerKind.Found, id };
            }
            if (outcome.status !== 0 && NO_SUCH_IMAGE.test(outcome.stderr)) {
                return { kind: ImageAnswerKind.Absent };
            }
            return { kind: ImageAnswerKind.Unanswered, problem: problem(outcome) };
        },
        async createNetwork(name, options) {
            const outcome = await runDocker([
                "network",
                "create",
                ...(options.internal ? ["--internal", "--opt", NO_GATEWAY_OPTION] : []),
                name,
            ]);
            if (outcome.status === 0) {
                return success(undefined);
            }
            const kind =
                options.internal && isInternalNetworkRefused(outcome)
                    ? NetworkFailureKind.InternalRefused
                    : NetworkFailureKind.Failed;
            return failure({ kind, detail: problem(outcome).detail });
        },
        async removeNetwork(name) {
            const outcome = await runDocker(["network", "rm", name]);
            return outcome.status === 0 ? success(undefined) : failure(problem(outcome));
        },
        async networkGatewayAddress(network) {
            const outcome = await runDocker([
                "network",
                "inspect",
                "--format",
                "{{json .}}",
                network,
            ]);
            return isWholeAnswer(outcome)
                ? gatewayAddressIn(outcome.stdout)
                : failure(problem(outcome));
        },
        async startContainer(options) {
            const created = await runDocker(
                createArguments(options),
                DOCKER_COMMAND_TIMEOUT_MILLISECONDS,
                options.environment,
            );
            if (created.status !== 0) {
                return failure(problem(created));
            }
            // It was created, but its id is not known: only its name can remove it.
            if (created.isOutputCutShort) {
                return failure(startProblem(created, await removeContainer(options.name)));
            }
            const containerId = created.stdout.trim();
            for (const network of options.networks.slice(1)) {
                const joined = await runDocker(["network", "connect", network, containerId]);
                if (joined.status !== 0) {
                    return failure(startProblem(joined, await removeContainer(containerId)));
                }
            }
            const started = await runDocker(["start", containerId]);
            if (started.status !== 0) {
                return failure(startProblem(started, await removeContainer(containerId)));
            }
            return success(containerId);
        },
        exec: (containerId, command, environmentNames) =>
            execWithin(null, containerId, command, environmentNames),
        async probeEgress(containerId, targets) {
            const probed = await execWithin(DOCKER_COMMAND_TIMEOUT_MILLISECONDS, containerId, [
                "node",
                "-e",
                probeScript(targets),
            ]);
            if (
                !probed.ok ||
                probed.value.exitCode !== 0 ||
                probed.value.isOutputCutShort === true
            ) {
                return "reached";
            }
            return probed.value.stdout.trim().split("\n").at(-1) === "blocked"
                ? "blocked"
                : "reached";
        },
        removeContainer,
        async imageUser(reference) {
            const outcome = await runDocker([
                "image",
                "inspect",
                "--format",
                "{{.Config.User}}",
                reference,
            ]);
            if (!isWholeAnswer(outcome)) {
                return failure(problem(outcome));
            }
            const user = outcome.stdout.trim();
            return success(user === "" ? null : user);
        },
        async containerAddress(containerId, network) {
            const outcome = await runDocker([
                "container",
                "inspect",
                "--format",
                "{{json .NetworkSettings.Networks}}",
                containerId,
            ]);
            return isWholeAnswer(outcome)
                ? networkAddress(outcome.stdout, network)
                : failure(problem(outcome));
        },
    };
}

const fieldOf = (value: unknown, name: string): unknown =>
    typeof value === "object" && value !== null
        ? Object.getOwnPropertyDescriptor(value, name)?.value
        : undefined;

const IPV4_SUBNET = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

// The first address of an IPv4 subnet such as "172.18.0.0/16", or null for anything else. That takes
// in numbers out of range, which would name no real address, and a prefix over 30, which leaves no
// address after the subnet's own for a gateway to take.
function firstAddressOf(subnet: unknown): string | null {
    const parts = typeof subnet === "string" ? IPV4_SUBNET.exec(subnet) : null;
    if (parts === null) {
        return null;
    }
    const octets = parts.slice(1, 5).map(Number);
    const prefix = Number(parts[5]);
    if (octets.some((octet) => octet > 255) || prefix > 30) {
        return null;
    }
    const address = octets.reduce((total, octet) => total * 256 + octet, 0);
    const size = 2 ** (32 - prefix);
    const first = address - (address % size) + 1;
    return [24, 16, 8, 0].map((shift) => Math.floor(first / 2 ** shift) % 256).join(".");
}

// See networkGatewayAddress, from Docker's JSON description of the network.
function gatewayAddressIn(description: string): Result<string | null, EngineProblem> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(description);
    } catch {
        return failure({ detail: "Docker's description of the network is not JSON" });
    }
    const pools = fieldOf(fieldOf(parsed, "IPAM"), "Config");
    if (!Array.isArray(pools)) {
        return failure({ detail: "Docker's description of the network names no address pools" });
    }
    const pool: unknown[] = pools;
    const first = pool
        .map((entry) => firstAddressOf(fieldOf(entry, "Subnet")))
        .find((address) => address !== null);
    // Null below says a container holds the first address. With no IPv4 subnet that is unknown, and as
    // null it would drop the gateway from the probe.
    if (first === undefined) {
        return failure({ detail: "Docker's description of the network shows no IPv4 subnet" });
    }
    const containers = fieldOf(parsed, "Containers");
    const members: unknown[] =
        typeof containers === "object" && containers !== null ? Object.values(containers) : [];
    const held = members.some((member) => {
        const address = fieldOf(member, "IPv4Address");
        return typeof address === "string" && address.split("/")[0] === first;
    });
    return success(held ? null : first);
}

// A container's IPv4 address on `network`, from Docker's JSON listing of its networks.
function networkAddress(listing: string, network: string): Result<string, EngineProblem> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(listing);
    } catch {
        return failure({ detail: "Docker's listing of the container's networks is not JSON" });
    }
    const address = fieldOf(fieldOf(parsed, network), "IPAddress");
    return typeof address === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(address)
        ? success(address)
        : failure({ detail: `the container has no address on the network ${network}` });
}
