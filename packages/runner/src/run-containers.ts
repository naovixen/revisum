// What the isolated runner and the workload runner share: the run image's containers, the egress
// proxy container and how its decisions are read back, the waits and probes that show egress is
// enforced, and the hardening every container gets. Both runners build their networks from these,
// so a plan run and an evidence run are isolated the same way.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md and docs/specs/SPEC-35-evidence-mode.md.
import { PRODUCT, type DeclaredService, type EgressPolicy, type ProxyDecision } from '@revisum/contracts';
import { platform } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { ContainerEngine, ContainerMount, ContainerOptions, ProbeTarget } from './container-engine.ts';
import { proxyRules } from './egress-proxy.ts';
import { DECISIONS_FILE, LOOKUPS_FILE, LOOKUPS_VARIABLE, RULES_VARIABLE, PROXY_PORT, readProxyDecision } from './proxy-container.ts';

// Where Revisum's own files appear inside the run image's containers.
export const WORKSPACE = '/workspace';
// The run image's own user, which is not root.
export const RUN_IMAGE_USER = 'node';
export const SECCOMP_PROFILE = join('.devcontainer', 'seccomp-chrome-sandbox.json');
const DEV_CONTAINER_DEPENDENCIES_VOLUME = `${PRODUCT.name}-node-modules`;
export const DEFAULT_BRIDGE_NETWORK = 'bridge';
const PROXY_READY_SECONDS = 30;
// Public addresses that answer from any ordinary network. A probe from inside a container on the
// run's network must reach none of them.
export const OUTSIDE_PROBE_TARGETS: readonly ProbeTarget[] = [{ host: '1.1.1.1', port: 443 }, { host: '8.8.8.8', port: 53 }];

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

// A repository-relative folder, refused when it leads out of the repository or into .git.
export function repositoryFolder(input: string): string | null {
  const path = normalize(input);
  if (path === '' || path === '.' || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..' || part === '.git')) return null;
  return path.split(sep).join('/');
}

// The Docker volume holding Linux dependencies, for a host whose own node_modules are not Linux's:
// the dev container's volume everywhere but Linux, where the repository's own folder is mounted.
export const dependenciesVolumeFor = (chosen: string | null | undefined): string | null =>
  chosen === undefined ? (platform() === 'linux' ? null : DEV_CONTAINER_DEPENDENCIES_VOLUME) : chosen;

// Revisum's own code and dependencies, read-only, for the run image's containers.
export const revisumMounts = (root: string, dependenciesVolume: string | null): ContainerMount[] => [
  { kind: 'folder', source: join(root, 'packages'), target: `${WORKSPACE}/packages` },
  { kind: 'file', source: join(root, 'package.json'), target: `${WORKSPACE}/package.json` },
  dependenciesVolume === null
    ? { kind: 'folder', source: join(root, 'node_modules'), target: `${WORKSPACE}/node_modules` }
    : { kind: 'volume', source: dependenciesVolume, target: `${WORKSPACE}/node_modules` },
];

// A container of the run image, started as its own user under the pinned seccomp profile.
export const runImageContainer = (root: string, fields: {
  readonly name: string; readonly image: string; readonly networks: readonly string[];
  readonly environment: Readonly<Record<string, string>>; readonly mounts: readonly ContainerMount[]; readonly command: readonly string[];
}): ContainerOptions => ({ ...fields, user: RUN_IMAGE_USER, seccompProfile: join(root, SECCOMP_PROFILE), workingFolder: WORKSPACE });

export type ProxyContainerFields = {
  readonly name: string;
  readonly image: string;
  readonly networks: readonly string[];
  readonly policy: EgressPolicy;
  readonly services?: readonly DeclaredService[] | undefined;
  readonly mounts: readonly ContainerMount[];
  // Also answer and record the run network's name lookups, for a workload container.
  readonly recordLookups?: boolean;
};

// The egress proxy's container, with its rules in its environment and nothing from the host's.
export const proxyContainer = (root: string, fields: ProxyContainerFields): ContainerOptions => runImageContainer(root, {
  name: fields.name, image: fields.image, networks: fields.networks, mounts: fields.mounts,
  environment: {
    HOME: '/tmp', [RULES_VARIABLE]: JSON.stringify(proxyRules(fields.policy, fields.services)),
    ...(fields.recordLookups === true ? { [LOOKUPS_VARIABLE]: '1' } : {}),
  },
  command: ['node', 'packages/runner/src/proxy-container.ts'],
});

export const proxyUrl = (proxyName: string): string => `http://${proxyName}:${PROXY_PORT}`;

// The lines of a file inside a container, or null when it cannot be read. A file not yet written
// reads as no lines, since the proxy writes each file only once it has something to record.
async function linesOf(engine: ContainerEngine, containerId: string, file: string): Promise<readonly string[] | null> {
  const read = await engine.exec(containerId, ['cat', file]);
  if (!read.ok) return null;
  return read.value.exitCode === 0 ? read.value.stdout.split('\n') : [];
}

// The proxy's decisions so far, read back from its container, or null when they cannot be read.
export async function readDecisions(engine: ContainerEngine, proxyId: string): Promise<readonly ProxyDecision[] | null> {
  const lines = await linesOf(engine, proxyId, DECISIONS_FILE);
  return lines === null ? null : lines.map(readProxyDecision).filter((decision) => decision !== null);
}

// The names looked up on the run's network so far, as the proxy container recorded them.
export async function readLookups(engine: ContainerEngine, proxyId: string): Promise<readonly string[]> {
  return ((await linesOf(engine, proxyId, LOOKUPS_FILE)) ?? []).map(readRecordedLookup).filter((name) => name !== null);
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
  const name: unknown = typeof parsed === 'object' && parsed !== null ? Object.getOwnPropertyDescriptor(parsed, 'name')?.value : undefined;
  return typeof name === 'string' && HOST_NAME.test(name) ? name : null;
}
