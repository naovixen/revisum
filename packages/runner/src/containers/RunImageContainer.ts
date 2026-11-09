// What the isolated runner and the workload runner share: the run image's containers, the egress
// proxy container and how its decisions are read back, the waits and probes that show egress is
// enforced, and the hardening every container gets. Both runners build their networks from these,
// so a plan run and an evidence run are isolated the same way.
import {
    PRODUCT,
    success,
    type AppliedRewrite,
    type DeclaredService,
    type EgressPolicy,
    type ProxyDecision,
    type Result,
} from "@revisum/contracts";
import { platform } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import type {
    ContainerEngine,
    ContainerMount,
    ContainerOptions,
    ProbeTarget,
} from "./ContainerEngine.ts";
import { proxyRules } from "../egress-proxy/rules/ParseProxyRules.ts";
import type { ProxyRulesRefusal } from "../egress-proxy/rules/ProxyRulesRefusal.ts";
import {
    DECISIONS_FILE,
    LOOKUPS_FILE,
    LOOKUPS_VARIABLE,
    RECORDS_LOST,
    RECORDS_STATE_FILE,
    REWRITES_FILE,
    RULES_VARIABLE,
    PROXY_PORT,
    RUN_ADDRESSES_VARIABLE,
    SERVICE_PROXY_PORT,
    readAppliedRewrite,
    readProxyDecision,
} from "../egress/StartRecordKeeping.ts";
import { readInContainer } from "./WithinReadBound.ts";
import { MountKind } from "./ContainerEngine.ts";
import { isSafeInMountArgument } from "../workload/team-container/IsSafeInMountArgument.ts";

// Where Revisum's own files appear inside the run image's containers.
export const WORKSPACE = "/workspace";
// The run image's own user, which is not root.
export const RUN_IMAGE_USER = "node";
export const SECCOMP_PROFILE = join(".devcontainer", "seccomp-chrome-sandbox.json");
const DEV_CONTAINER_DEPENDENCIES_VOLUME = `${PRODUCT.name}-node-modules`;
export const DEFAULT_BRIDGE_NETWORK = "bridge";
const PROXY_READY_SECONDS = 30;
// Public addresses that answer from any ordinary network. A probe from inside a container on the
// run's network must reach none of them.
const OUTSIDE_PROBE_TARGETS: readonly ProbeTarget[] = [
    { host: "1.1.1.1", port: 443 },
    { host: "8.8.8.8", port: 53 },
];
// Any port will do for a gateway, since its refusal counts as reaching it.
const GATEWAY_PROBE_PORT = 80;
const NO_SUCH_FILE = /no such file/i;

// Tries, from a container on the run's network, to get out without the proxy: to public addresses,
// and to the Docker host through the network's gateway, which a Docker that ignores the option to
// remove it would keep. 'reached' too when the network cannot be read or shows no IPv4 subnet, so an
// unknown is never taken for 'blocked'.
export async function probeRunNetwork(
    engine: ContainerEngine,
    containerId: string,
    network: string,
): Promise<"reached" | "blocked"> {
    const gateway = await engine.networkGatewayAddress(network);
    if (!gateway.ok) {
        return "reached";
    }
    const gatewayTargets: readonly ProbeTarget[] =
        gateway.value === null
            ? []
            : [{ host: gateway.value, port: GATEWAY_PROBE_PORT, refusalCountsAsReached: true }];
    return engine.probeEgress(containerId, [...OUTSIDE_PROBE_TARGETS, ...gatewayTargets]);
}

// Waits until the proxy accepts connections, trying once a second.
export const proxyReadyScript = (host: string): string => `
  const { connect } = require('node:net');
  let tries = ${PROXY_READY_SECONDS};
  const attempt = () => {
    const socket = connect({ host: ${JSON.stringify(host)}, port: ${PROXY_PORT} });
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('error', () => { socket.destroy(); tries -= 1; if (tries === 0) process.exit(1); else setTimeout(attempt, 1000); });
  };
  attempt();`;

// True for a name that is the .git folder however it is written, since Windows ignores case.
export const isGitFolderName = (name: string): boolean => name.toLowerCase() === ".git";

// A repository-relative folder, refused when it leads out of the repository or into .git, or holds
// what a Docker --mount argument cannot carry.
export function repositoryFolder(input: string): string | null {
    const path = normalize(input);
    if (
        path === "" ||
        path === "." ||
        isAbsolute(path) ||
        !isSafeInMountArgument(path) ||
        path.split(/[\\/]/).some((part) => part === ".." || isGitFolderName(part))
    ) {
        return null;
    }
    return path.split(sep).join("/");
}

// The Docker volume holding Linux dependencies, for a host whose own node_modules are not Linux's:
// the dev container's volume everywhere but Linux, where the repository's own folder is mounted.
const defaultDependenciesVolume = (): string | null =>
    platform() === "linux" ? null : DEV_CONTAINER_DEPENDENCIES_VOLUME;

export const dependenciesVolumeFor = (chosen: string | null | undefined): string | null =>
    chosen === undefined ? defaultDependenciesVolume() : chosen;

// Revisum's own code and dependencies, read-only, for the run image's containers.
export const ownCodeMounts = (
    root: string,
    dependenciesVolume: string | null,
): ContainerMount[] => [
    { kind: MountKind.Folder, source: join(root, "packages"), target: `${WORKSPACE}/packages` },
    {
        kind: MountKind.File,
        source: join(root, "package.json"),
        target: `${WORKSPACE}/package.json`,
    },
    dependenciesVolume === null
        ? {
              kind: MountKind.Folder,
              source: join(root, "node_modules"),
              target: `${WORKSPACE}/node_modules`,
          }
        : {
              kind: MountKind.Volume,
              source: dependenciesVolume,
              target: `${WORKSPACE}/node_modules`,
          },
];

// A container of the run image, started as its own user under the pinned seccomp profile.
export const runImageContainer = (
    root: string,
    fields: {
        readonly name: string;
        readonly image: string;
        readonly networks: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
        readonly mounts: readonly ContainerMount[];
        readonly command: readonly string[];
    },
): ContainerOptions => ({
    ...fields,
    user: RUN_IMAGE_USER,
    seccompProfile: join(root, SECCOMP_PROFILE),
    workingFolder: WORKSPACE,
});

// What a run's proxy is for. run-container: a plan run's browser and its service calls each get an
// address. workload: it also answers and records the run network's name lookups.
export const ProxyRole = {
    RunContainer: "run-container",
    Workload: "workload",
} as const;
export type ProxyRole = (typeof ProxyRole)[keyof typeof ProxyRole];

const PROXY_ROLE_VARIABLES = {
    [ProxyRole.RunContainer]: { [RUN_ADDRESSES_VARIABLE]: "1" },
    [ProxyRole.Workload]: { [LOOKUPS_VARIABLE]: "1" },
} satisfies Record<ProxyRole, Readonly<Record<string, string>>>;

export type ProxyContainerFields = {
    readonly name: string;
    readonly image: string;
    readonly networks: readonly string[];
    readonly policy: EgressPolicy;
    readonly services?: readonly DeclaredService[] | undefined;
    readonly mounts: readonly ContainerMount[];
    readonly role: ProxyRole;
};

// The egress proxy's container, with its rules in its environment and nothing from the host's.
export function proxyContainer(
    root: string,
    fields: ProxyContainerFields,
): Result<ContainerOptions, ProxyRulesRefusal> {
    const rules = proxyRules(fields.policy, fields.services);
    if (!rules.ok) {
        return rules;
    }
    return success(
        runImageContainer(root, {
            name: fields.name,
            image: fields.image,
            networks: fields.networks,
            mounts: fields.mounts,
            environment: {
                HOME: "/tmp",
                [RULES_VARIABLE]: JSON.stringify(rules.value),
                ...PROXY_ROLE_VARIABLES[fields.role],
            },
            command: ["node", "packages/runner/src/egress/StartRecordKeeping.ts"],
        }),
    );
}

export const proxyUrl = (proxyName: string): string => `http://${proxyName}:${PROXY_PORT}`;
export const serviceProxyUrl = (proxyName: string): string =>
    `http://${proxyName}:${SERVICE_PROXY_PORT}`;

// The lines of a file inside a container, or null when it cannot be read whole, so a caller can keep
// what it read before. A file not yet written reads as no lines, since the proxy writes each file
// only once it has something to record. Only the message tells that apart: a stopped container exits
// with the same status.
async function linesOf(
    engine: ContainerEngine,
    containerId: string,
    file: string,
): Promise<readonly string[] | null> {
    const read = await readInContainer(engine, containerId, ["cat", file]);
    if (!read.ok || read.value.isOutputCutShort === true) {
        return null;
    }
    if (read.value.exitCode === 0) {
        return read.value.stdout.split("\n");
    }
    return NO_SUCH_FILE.test(read.value.stderr) ? [] : null;
}

// The proxy's decisions so far, read back from its container, or null when they cannot be read.
export async function readDecisions(
    engine: ContainerEngine,
    proxyId: string,
): Promise<readonly ProxyDecision[] | null> {
    const lines = await linesOf(engine, proxyId, DECISIONS_FILE);
    return lines === null
        ? null
        : lines.map(readProxyDecision).filter((decision) => decision !== null);
}

// The rewrites the proxy has applied so far, read back from its container, or null when they cannot be read.
export async function readAppliedRewrites(
    engine: ContainerEngine,
    proxyId: string,
): Promise<readonly AppliedRewrite[] | null> {
    const lines = await linesOf(engine, proxyId, REWRITES_FILE);
    return lines === null
        ? null
        : lines.map(readAppliedRewrite).filter((applied) => applied !== null);
}

// The names looked up on the run's network so far, as the proxy container recorded them, or null
// when they cannot be read.
export async function readLookups(
    engine: ContainerEngine,
    proxyId: string,
): Promise<readonly string[] | null> {
    const lines = await linesOf(engine, proxyId, LOOKUPS_FILE);
    return lines === null ? null : lines.map(readRecordedLookup).filter((name) => name !== null);
}

// True when the proxy could not write a record, or cannot say whether it could.
export async function hasProxyLostRecords(
    engine: ContainerEngine,
    proxyId: string,
): Promise<boolean> {
    const lines = await linesOf(engine, proxyId, RECORDS_STATE_FILE);
    return lines === null || lines.includes(RECORDS_LOST);
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*$/;

// One lookup line the proxy container wrote, or null when the line is anything else.
export function readRecordedLookup(line: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    const name: unknown =
        typeof parsed === "object" && parsed !== null
            ? Object.getOwnPropertyDescriptor(parsed, "name")?.value
            : undefined;
    return typeof name === "string" && HOST_NAME.test(name) ? name : null;
}
