// The workload runner: a team's own image, pinned by digest, runs one argument vector behind the
// isolated runner's egress proxy. It reuses the isolated runner's network and proxy (run-containers.ts):
// a network with no route out (--internal), the proxy container joining it and the default bridge,
// and the same hardening for every container.
//
// Unlike a plan run, a workload never falls back to the host level. Suite code is the team's own,
// so unless the internal network exists, the proxy answers and a probe container on the network
// fails to reach an address outside or the Docker host, run() returns egress-unenforceable before
// any container of the team's image is started.
//
// The team's container never runs as root, joins only the run's network, gets the checkout
// read-only without .git and Revisum's output folder as its only writable mount, and an
// environment of the declared variables and Revisum's own proxy settings, never the host's. Its
// name lookups are forwarded to the proxy container, which answers none and records each, so a
// process that ignores the proxy is still seen (channel process). The command runs through exec,
// as an argument vector, never through a shell; at its timeout the container is removed.
//
// A database command's request names the one service its policy allows over TCP. The proxy relays
// that service's port to the service's address, and the team's container maps the service's name
// (and its origin's host name, when that is a name) to the proxy, so the command connects by name.
// Every other address still has no route. Such a request asks for no proxy variables, since the
// command speaks TCP, not HTTP.
import {
  PRODUCT, WORKLOAD_CHECKOUT_PATH, WORKLOAD_OUTPUT_PATH, failure, hostAndPort, success,
  type CapturedOutput, type EgressEvent, type EgressPolicy, type ExecOutcome, type OutputRemoval, type ProxyDecision, type Result, type WorkloadErrorCode,
  type WorkloadOutcome, type WorkloadRequest, type WorkloadRunner,
} from '@revisum/contracts';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ContainerEngine, ContainerMount, EngineProblem, HostEntry } from './container-engine.ts';
import { joinEgressEvents } from './egress-events.ts';
import { relayOrigin, tcpRelaysFor } from './egress-proxy.ts';
import { PROXY_PORT } from './proxy-container.ts';
import {
  DEFAULT_BRIDGE_NETWORK, SECCOMP_PROFILE, dependenciesVolumeFor, hasProxyLostRecords, isGitFolderName, ownCodeMounts, probeRunNetwork, proxyContainer, proxyReadyScript, proxyUrl,
  readDecisions, readLookups, repositoryFolder, runImageContainer,
} from './run-containers.ts';
import { RUN_IMAGE_TAG } from './run-image.ts';
import { workloadEnvironment } from './workload-environment.ts';

// A refusal's reason, or a notice: something that did not stop the run but limits what it shows.
export type WorkloadLogEntry = { readonly code: WorkloadErrorCode | 'notice'; readonly detail: string };

export type WorkloadRunnerOptions = {
  readonly engine: ContainerEngine;
  // Revisum's own files: the proxy's code and the seccomp profile.
  readonly repositoryRoot: string;
  // The host folder of the repository under test, mounted read-only.
  readonly checkout: string;
  // As for dockerRunner: the Docker volume of Linux dependencies for the proxy's code.
  readonly dependenciesVolume?: string | null;
  readonly log?: (entry: WorkloadLogEntry) => void;
};

// Each stream is cut here, so a chatty suite cannot exhaust memory or bloat what is kept.
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
// The uid and gid used when the image's own user is root, or the image names none.
const UNPRIVILEGED_USER = '1000:1000';
// Characters a host path may not hold in a Docker --mount argument, which they would break or
// extend with options of their own.
const MOUNT_UNSAFE = /[,"=\u0000-\u001f]/;
// What the team's container runs to stay up while its command runs through exec: only this,
// never the image's own entrypoint.
const KEEP_ALIVE = { entrypoint: 'sleep', command: ['infinity'] } as const;

// True when a user names root: "root", "0", or either with a group.
const isRoot = (user: string): boolean => /^(root|0)(:|$)/.test(user.trim());

// What a stream printed, cut at the limit.
function captured(text: string, limit: number): CapturedOutput {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= limit
    ? { bytes: new Uint8Array(bytes), truncated: false }
    : { bytes: new Uint8Array(bytes.subarray(0, limit)), truncated: true };
}

// The names the team's container resolves to the proxy, one per relayed service: the service's
// own name, and its origin's host when that is a name rather than an address.
function relayedHostNames(request: WorkloadRequest): readonly string[] {
  const relayed = (request.services ?? []).filter((service) => request.policy.allowTcpServices.includes(service.name) && service.port !== undefined);
  const names = relayed.flatMap((service) => {
    const host = new URL(service.origin).hostname;
    return isIP(host.replace(/^\[(.*)\]$/, '$1')) === 0 ? [service.name, host] : [service.name];
  });
  return [...new Set<string>(names)];
}

// The host part of an origin the proxy decided on, so a lookup of the same name is not counted twice.
function decidedHost(origin: string): string {
  const hostPort = hostAndPort(origin);
  const bracketed = /^\[([^\]]+)\]/.exec(hostPort);
  if (bracketed !== null) return (bracketed[1] ?? '').toLowerCase();
  return (hostPort.split(':')[0] ?? '').toLowerCase();
}

// The lookups no proxy decision accounts for and no declared origin explains, once per name, as
// blocked attempts of a process that ignored the proxy.
function processEvents(lookups: readonly string[], decisions: readonly ProxyDecision[], policy: EgressPolicy): readonly EgressEvent[] {
  const explained = new Set([
    ...decisions.map((decision) => decidedHost(decision.origin)),
    ...policy.allowOrigins.map((origin) => decidedHost(origin)),
  ]);
  return [...new Set(lookups)].filter((name) => !explained.has(name)).map((name): EgressEvent => ({ origin: name, channel: 'process', decision: 'blocked' }));
}

// The checkout's top-level entries as read-only mounts, leaving out .git, links (whose targets could
// lie outside the checkout) and names a mount argument cannot hold. Null when the checkout cannot be read.
function checkoutMounts(checkout: string, log: (entry: WorkloadLogEntry) => void): ContainerMount[] | null {
  let entries;
  try {
    entries = readdirSync(checkout, { withFileTypes: true });
  } catch {
    return null;
  }
  const mounts: ContainerMount[] = [];
  for (const entry of entries) {
    if (isGitFolderName(entry.name) || entry.isSymbolicLink()) continue;
    if (MOUNT_UNSAFE.test(entry.name)) {
      log({ code: 'notice', detail: 'a top-level entry of the checkout has a name Docker cannot mount; it is left out' });
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) continue;
    mounts.push({ kind: entry.isDirectory() ? 'folder' : 'file', source: join(checkout, entry.name), target: `${WORKLOAD_CHECKOUT_PATH}/${entry.name}` });
  }
  return mounts;
}

// Readies the host output folder: it exists, and the container's user can write into it, which on
// Linux is another uid than the host's.
function readyOutputFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { recursive: true });
    if (platform() !== 'win32') chmodSync(folder, 0o777);
    return true;
  } catch {
    return false;
  }
}

// The user a team's containers run as: never root.
const containerUser = (imageUser: string | null): string => (imageUser === null || isRoot(imageUser) ? UNPRIVILEGED_USER : imageUser);

type Outcome = Result<WorkloadOutcome, WorkloadErrorCode>;

export function workloadRunner(options: WorkloadRunnerOptions): WorkloadRunner {
  const { engine, repositoryRoot: root, checkout } = options;
  const log = options.log ?? ((): void => undefined);
  const dependenciesVolume = dependenciesVolumeFor(options.dependenciesVolume);

  // Removes what an earlier container of the image left, as its own user, in a container of the same
  // image with no network and only the output folder. A mode the suite set on its own files could stop
  // even its own user, so that is lifted first. Neither command's outcome is read, since the caller
  // looks for itself, and an image that lacks them fails safe as a folder still there.
  async function removeFromOutput(removal: OutputRemoval): Promise<void> {
    const { image, outputDirectory, paths, hostFailure } = removal;
    if (!isAbsolute(outputDirectory) || MOUNT_UNSAFE.test(outputDirectory) || MOUNT_UNSAFE.test(root) || await engine.imageId(image) !== image || !readyOutputFolder(outputDirectory)) {
      log({ code: 'notice', detail: `the host could not remove what an earlier run left (${hostFailure}), and no container can be used to` });
      return;
    }
    const insideOutput = paths.map((path) => `${WORKLOAD_OUTPUT_PATH}/${path}`);
    const remover = await engine.startContainer({
      name: `${PRODUCT.name}-output-removal-${randomBytes(6).toString('hex')}`, image, networks: [],
      user: containerUser(await engine.imageUser?.(image) ?? null),
      seccompProfile: join(root, SECCOMP_PROFILE),
      workingFolder: WORKLOAD_OUTPUT_PATH,
      environment: { HOME: '/tmp' },
      mounts: [{ kind: 'folder', source: outputDirectory, target: WORKLOAD_OUTPUT_PATH, writable: true }],
      ...KEEP_ALIVE,
    });
    if (!remover.ok) {
      log({ code: 'notice', detail: `the host could not remove what an earlier run left (${hostFailure}), and the container to do it did not start: ${remover.error.detail}` });
      return;
    }
    try {
      await engine.exec(remover.value, ['chmod', '-R', 'u+rwx', ...insideOutput]);
      await engine.exec(remover.value, ['rm', '-rf', ...insideOutput]);
    } finally {
      await engine.removeContainer(remover.value);
    }
  }

  async function run(request: WorkloadRequest): Promise<Outcome> {
    const refuse = (code: WorkloadErrorCode, detail: string): Outcome => {
      log({ code, detail });
      return failure(code);
    };

    // ---- The request ----
    const workingFolder = request.workingDirectory === '.' ? '' : repositoryFolder(request.workingDirectory);
    if (workingFolder === null) return refuse('workload-start-failed', 'the working directory is not a folder inside the checkout');
    if (request.argv.length === 0) return refuse('workload-start-failed', 'the argument vector is empty');
    if (!Number.isFinite(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0) {
      return refuse('workload-start-failed', 'the timeout is not a positive number of milliseconds');
    }
    if (!isAbsolute(request.outputDirectory) || MOUNT_UNSAFE.test(request.outputDirectory) || MOUNT_UNSAFE.test(checkout) || MOUNT_UNSAFE.test(root)) {
      return refuse('workload-start-failed', 'the output folder, checkout or repository path cannot be mounted');
    }
    const outputLimit = request.maximumOutputBytes ?? OUTPUT_LIMIT_BYTES;
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 0) return refuse('workload-start-failed', 'the output limit is not a whole number of bytes');
    // Each relay listens on its service's own port, so two cannot share one, nor take the proxy's.
    const relays = tcpRelaysFor(request.policy, request.services ?? []);
    const relayPorts = relays.map((relay) => relay.port);
    if (new Set(relayPorts).size !== relayPorts.length || relayPorts.includes(PROXY_PORT)) {
      return refuse('workload-start-failed', 'two services allowed over TCP share a port, or one uses the proxy\'s own port');
    }

    // ---- The images. The team's image is never pulled: it must be here, with the pinned id. ----
    // A daemon that does not answer says nothing about whether an image exists.
    const imageAbsent = async (detail: string): Promise<Outcome> => {
      const unanswered = await engine.daemonProblem?.() ?? null;
      return unanswered === null ? refuse('image-missing', detail) : refuse('workload-start-failed', `Docker did not answer: ${unanswered.detail}`);
    };
    const runImage = await engine.imageId(RUN_IMAGE_TAG);
    if (runImage === null) return imageAbsent(`the run image ${RUN_IMAGE_TAG} is not on this host`);
    const teamImage = await engine.imageId(request.image);
    if (teamImage === null) return imageAbsent('the workload image is not on this host');
    if (teamImage !== request.image) return refuse('image-digest-mismatch', 'the local workload image has another id than the request pins');

    const runId = `${PRODUCT.name}-workload-${randomBytes(6).toString('hex')}`;
    const network = `${runId}-network`;
    const containers: string[] = [];
    let networkCreated = false;
    const removeAll = async (): Promise<void> => {
      for (const containerId of containers.splice(0).reverse()) await engine.removeContainer(containerId);
      if (networkCreated) await engine.removeNetwork(network);
      networkCreated = false;
    };
    try {
      return await runInside(runImage);
    } finally {
      await removeAll();
    }

    async function runInside(runImage: string): Promise<Outcome> {
      const unenforceable = (detail: string): Outcome => refuse('egress-unenforceable', detail);

      // ---- Egress control, shown before any code of the team's image runs ----
      const created = await engine.createNetwork(network, { internal: true });
      if (!created.ok) return unenforceable(`Docker could not create a network with no route out: ${created.error.detail}`);
      networkCreated = true;

      const proxyName = `${runId}-proxy`;
      const proxy = await engine.startContainer(proxyContainer(root, {
        name: proxyName, image: runImage, networks: [network, DEFAULT_BRIDGE_NETWORK], policy: request.policy, services: request.services,
        mounts: ownCodeMounts(root, dependenciesVolume), recordLookups: true,
      }));
      if (!proxy.ok) return unenforceable(`the proxy container did not start: ${proxy.error.detail}`);
      containers.push(proxy.value);
      const proxyId = proxy.value;

      // A container of Revisum's own image on the run's network proves the network has no route
      // out, so the team's image is started only once that is shown.
      const probe = await engine.startContainer(runImageContainer(root, {
        name: `${runId}-probe`, image: runImage, networks: [network], environment: { HOME: '/tmp' }, mounts: [], command: ['sleep', 'infinity'],
      }));
      if (!probe.ok) return unenforceable(`the probe container did not start: ${probe.error.detail}`);
      containers.push(probe.value);
      const ready = await engine.exec(probe.value, ['node', '-e', proxyReadyScript(proxyName)]);
      if (!ready.ok || ready.value.exitCode !== 0) {
        return unenforceable(`the run's network cannot reach its proxy: ${ready.ok ? ready.value.stderr.trim() : ready.error.detail}`);
      }
      if (await probeRunNetwork(engine, probe.value, network) === 'reached') {
        return unenforceable('a connection from inside the run\'s network reached an address outside, or the Docker host, without the proxy');
      }
      await engine.removeContainer(probe.value);
      containers.splice(containers.indexOf(probe.value), 1);

      // ---- The team's container ----
      const environment = workloadEnvironment(request.environment, proxyUrl(proxyName), request.httpProxyVariables !== false);
      if (environment === null) return refuse('workload-start-failed', 'a declared variable has a name an environment cannot hold');
      const mounts = checkoutMounts(checkout, log);
      if (mounts === null) return refuse('workload-start-failed', 'the checkout cannot be read');
      if (!readyOutputFolder(request.outputDirectory)) return refuse('workload-start-failed', 'the output folder cannot be made writable');
      const imageUser = await engine.imageUser?.(request.image) ?? null;
      const proxyAddress = await engine.containerAddress?.(proxyId, network) ?? null;
      if (proxyAddress === null) log({ code: 'notice', detail: 'the proxy has no address on the run\'s network, so lookups are not recorded' });
      // A relayed service is reached by name at the proxy, so without the proxy's address it cannot be reached.
      const relayedNames = relayedHostNames(request);
      if (relayedNames.length > 0 && proxyAddress === null) {
        return refuse('workload-start-failed', 'the proxy has no address on the run\'s network, so the service allowed over TCP cannot be reached');
      }
      const hosts: HostEntry[] = proxyAddress === null ? [] : relayedNames.map((name) => ({ name, address: proxyAddress }));

      const team = await engine.startContainer({
        name: `${runId}-workload`, image: request.image, networks: [network],
        user: containerUser(imageUser),
        seccompProfile: join(root, SECCOMP_PROFILE),
        workingFolder: workingFolder === '' ? WORKLOAD_CHECKOUT_PATH : `${WORKLOAD_CHECKOUT_PATH}/${workingFolder}`,
        environment,
        mounts: [...mounts, { kind: 'folder', source: request.outputDirectory, target: WORKLOAD_OUTPUT_PATH, writable: true }],
        ...KEEP_ALIVE,
        ...(proxyAddress === null ? {} : { dns: [proxyAddress] }),
        ...(hosts.length === 0 ? {} : { hosts }),
      });
      if (!team.ok) return refuse('workload-start-failed', `the workload container did not start: ${team.error.detail}`);
      containers.push(team.value);
      const teamId = team.value;

      // ---- The command, under its timeout ----
      const execution = engine.exec(teamId, request.argv);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => resolve('timed-out'), request.timeoutMilliseconds); });
      const first = await Promise.race([execution.then(() => 'finished' as const), timeout]);
      clearTimeout(timer);
      if (first === 'timed-out') {
        // Removing the container ends the command; what it printed until then is still returned.
        await engine.removeContainer(teamId);
        containers.splice(containers.indexOf(teamId), 1);
      }
      const finished: Result<ExecOutcome, EngineProblem> = await execution;
      if (!finished.ok && first !== 'timed-out') return refuse('workload-start-failed', `the command could not be run: ${finished.error.detail}`);
      const printed: ExecOutcome = finished.ok ? finished.value : { exitCode: -1, stdout: '', stderr: '' };

      const decisionsRead = await readDecisions(engine, proxyId);
      const lookupsRead = await readLookups(engine, proxyId);
      // A proxy that cannot be read is not a proxy that blocked nothing.
      const isEgressRecordUnread = decisionsRead === null || lookupsRead === null || await hasProxyLostRecords(engine, proxyId);
      if (isEgressRecordUnread) {
        log({ code: 'notice', detail: 'what the proxy decided could not be read back whole' });
      }
      const decisions = decisionsRead ?? [];
      const lookups = lookupsRead ?? [];
      // A relayed connection is the command's own, not a browser's: its channel is process.
      const relayed = new Set(relays.map(relayOrigin));
      const relayEvents = decisions.filter((decision) => relayed.has(decision.origin))
        .map((decision): EgressEvent => ({ origin: decision.origin, channel: 'process', decision: decision.decision }));
      return success({
        exitCode: printed.exitCode,
        timedOut: first === 'timed-out',
        egressEvents: [
          ...joinEgressEvents([], decisions.filter((decision) => !relayed.has(decision.origin))), ...relayEvents,
          ...processEvents(lookups, decisions, request.policy),
        ],
        ...(isEgressRecordUnread ? { egressRecordUnread: true } : {}),
        stdout: captured(printed.stdout, outputLimit),
        stderr: captured(printed.stderr, outputLimit),
      });
    }
  }

  return { run, removeFromOutput };
}
