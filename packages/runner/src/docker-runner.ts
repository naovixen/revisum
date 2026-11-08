// The isolated runner on a container engine. A run gets its own Docker network with no route out
// (--internal), a run container that joins only that network, and a proxy container, from the same
// image, that joins it and the default bridge and runs the egress proxy. The browser is pointed at
// the proxy, so a request that bypasses it has nowhere to go.
//
// The runner claims the isolated guarantee level only once all three have started and direct
// connections from inside the run container, to addresses outside and to the Docker host through
// any gateway the network kept, have failed. Otherwise the run still starts, at the host level, and
// logs egress-unenforceable, so no report claims isolation.
// Nothing reaches the containers from the host's environment: each environment is built from an
// empty list, and only the code, dependencies and browsers the run needs are mounted, read-only.
import {
  PRODUCT, failure, success,
  type AppliedRewrite, type DeclaredService, type EgressPolicy, type ExecOutcome, type GuaranteeLevel, type ImageDigest, type ProxyDecision, type Result, type Runner,
  type RunnerError, type RunnerHandle,
} from '@revisum/contracts';
import { join } from 'node:path';
import type { ContainerEngine, ContainerMount } from './container-engine.ts';
import { keepingContainerScope, type ContainerScope, type RemoveAll } from './ContainerScope.ts';
import { joinEgressEvents } from './egress-events.ts';
import {
  DEFAULT_BRIDGE_NETWORK, WORKSPACE, dependenciesVolumeFor, hasProxyLostRecords, ownCodeMounts, probeRunNetwork, proxyUrl,
  readAppliedRewrites, readDecisions, repositoryFolder, runImageContainer, serviceProxyUrl,
} from './run-containers.ts';
import { SERVICE_PROXY_VARIABLE } from './proxy-container.ts';
import { RUN_IMAGE_TAG } from './run-image.ts';
import { proxyUnreachableDetail, startProxyContainer } from './StartProxyContainer.ts';

// A variable name Docker copies from the client's environment, never read as NAME=value.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type RunnerLogEntry = { readonly code: 'egress-unenforceable' | 'start-failed'; readonly detail: string };

export type DockerRunnerOptions = {
  readonly engine: ContainerEngine;
  readonly repositoryRoot: string;
  // Repository-relative folders the run gets read-only, beside packages, node_modules and .browsers.
  readonly inputs?: readonly string[];
  // The trusted project's declared services; the policy says which of them the run may call.
  readonly services?: readonly DeclaredService[];
  // The Docker volume holding Linux dependencies, for a host whose own node_modules are not
  // Linux's. Defaults to the dev container's volume everywhere but Linux, where the repository's
  // own node_modules folder is mounted.
  readonly dependenciesVolume?: string | null;
  readonly log?: (entry: RunnerLogEntry) => void;
};

type RunnerLog = (entry: RunnerLogEntry) => void;

// What a run's setup needs, built once per start.
type RunSetup = {
  readonly engine: ContainerEngine;
  readonly root: string;
  readonly log: RunnerLog;
  readonly image: ImageDigest;
  readonly policy: EgressPolicy;
  readonly services: readonly DeclaredService[] | undefined;
  readonly inputs: readonly string[];
  readonly ownMounts: readonly ContainerMount[];
};

type RunContainerIds = { readonly runId: string; readonly proxyId: string; readonly runContainerId: string };

// Null when the run image is here and is the one pinned, otherwise why it cannot be used. A daemon
// that does not answer says nothing about whether the image exists.
async function pinRunImage(engine: ContainerEngine, image: ImageDigest, log: RunnerLog): Promise<RunnerError | null> {
  const localId = await engine.imageId(RUN_IMAGE_TAG);
  if (localId === null) {
    const unanswered = await engine.daemonProblem?.() ?? null;
    if (unanswered === null) {
      return { code: 'image-missing' };
    }
    log({ code: 'start-failed', detail: `Docker did not answer: ${unanswered.detail}` });
    return { code: 'start-failed' };
  }
  return localId === image ? null : { code: 'image-digest-mismatch' };
}

// The inputs as folders inside the repository, or null when one is not.
function repositoryInputs(inputs: readonly string[], log: RunnerLog): readonly string[] | null {
  const folders: string[] = [];
  for (const input of inputs) {
    const folder = repositoryFolder(input);
    if (folder === null) {
      log({ code: 'start-failed', detail: `the input ${input} is not a folder inside the repository` });
      return null;
    }
    folders.push(folder);
  }
  return folders;
}

// Why the run's network does not enforce egress, or null when it has no route out. Where Docker
// cannot make a network with no route out, the run goes ahead on an ordinary one, at the host level.
async function createRunNetwork(scope: ContainerScope): Promise<Result<string | null, string>> {
  const internal = await scope.createNetwork({ internal: true });
  if (internal.ok) {
    return success(null);
  }
  const ordinary = await scope.createNetwork({ internal: false });
  if (!ordinary.ok) {
    return failure(`Docker could not create the run's network: ${ordinary.error.detail}`);
  }
  return success(`Docker could not create a network with no route out: ${internal.error.detail}`);
}

// A browser takes HTTP_PROXY by default, so that is the address that closes the socket on a
// refusal. Whatever calls services has to ask for the one that answers. Wrongly used, that gives a
// service a failed call, never a page a readable answer.
function runContainerEnvironment(proxyName: string): Readonly<Record<string, string>> {
  const browserAddress = proxyUrl(proxyName);
  return {
    HOME: '/tmp', HTTP_PROXY: browserAddress, HTTPS_PROXY: browserAddress, NO_PROXY: 'localhost,127.0.0.1,::1',
    'http_proxy': browserAddress, 'https_proxy': browserAddress, 'no_proxy': 'localhost,127.0.0.1,::1',
    [SERVICE_PROXY_VARIABLE]: serviceProxyUrl(proxyName),
  };
}

// The handle a started run is given. It reads the proxy's files back as the run goes, and stop reads
// them once more before the scope's containers go.
function runnerHandleFor(setup: RunSetup, ids: RunContainerIds, startingLevel: GuaranteeLevel, removeAll: RemoveAll): RunnerHandle {
  const { engine, log } = setup;
  const { runContainerId, proxyId } = ids;
  let decisions: readonly ProxyDecision[] = [];
  let rewrites: readonly AppliedRewrite[] = [];
  let level = startingLevel;
  // A read that fails keeps what the last one found, since each file only grows. But the record may
  // then be incomplete, and egress is enforced only as far as it can be shown, so the run no longer
  // counts as isolated.
  const refreshEvidence = async (): Promise<void> => {
    const [readNow, appliedNow, hasLostRecords] = await Promise.all([
      readDecisions(engine, proxyId), readAppliedRewrites(engine, proxyId), hasProxyLostRecords(engine, proxyId),
    ]);
    decisions = readNow ?? decisions;
    rewrites = appliedNow ?? rewrites;
    if (level === 'isolated' && (readNow === null || hasLostRecords)) {
      level = 'host';
      log({ code: 'egress-unenforceable', detail: 'what the proxy decided could not be read back whole' });
    }
  };
  let isStopped = false;
  return {
    runId: ids.runId,
    egressEvents: (records = [], directOrigins = []) => joinEgressEvents(records, decisions, directOrigins),
    proxyDecisions: () => decisions,
    rewritesApplied: () => rewrites,
    async exec(command, environmentNames = []): Promise<ExecOutcome> {
      // A name that is not a plain variable name could be read by Docker as NAME=value.
      if (!environmentNames.every((name) => VARIABLE_NAME.test(name))) {
        return { exitCode: -1, stdout: '', stderr: 'an environment variable name is not a plain name' };
      }
      const outcome = await engine.exec(runContainerId, command, environmentNames);
      await refreshEvidence();
      return outcome.ok ? outcome.value : { exitCode: -1, stdout: '', stderr: outcome.error.detail };
    },
    async stop() {
      if (isStopped) {
        return;
      }
      isStopped = true;
      await refreshEvidence();
      await removeAll();
    },
    guaranteeLevel: () => level,
  };
}

// The network, the proxy and the run container, in their order, and what they show about egress. A
// problem leaves nothing behind, since the scope removes whatever was started.
async function startRunInScope(setup: RunSetup, scope: ContainerScope, removeAll: RemoveAll): Promise<Result<RunnerHandle, RunnerError>> {
  const { engine, root, log, image, inputs, ownMounts } = setup;
  const refuse = (detail: string): Result<RunnerHandle, RunnerError> => {
    log({ code: 'start-failed', detail });
    return failure({ code: 'start-failed' });
  };

  const network = await createRunNetwork(scope);
  if (!network.ok) {
    return refuse(network.error);
  }
  const whyNotEnforced = network.value;

  const proxy = await startProxyContainer(scope, root, {
    image, networks: whyNotEnforced === null ? [scope.network, DEFAULT_BRIDGE_NETWORK] : [scope.network],
    policy: setup.policy, services: setup.services, mounts: ownMounts, hasRunAddresses: true,
  });
  if (!proxy.ok) {
    return refuse(proxy.error);
  }

  const runMounts: ContainerMount[] = [
    ...ownMounts,
    { kind: 'folder', source: join(root, '.browsers'), target: `${WORKSPACE}/.browsers` },
    ...inputs.map((input): ContainerMount => ({ kind: 'folder', source: join(root, input), target: `${WORKSPACE}/${input}` })),
  ];
  const runContainer = await scope.startContainer(runImageContainer(root, {
    name: `${scope.runId}-run`, image, networks: [scope.network], environment: runContainerEnvironment(proxy.value.name), mounts: runMounts, command: ['sleep', 'infinity'],
  }));
  if (!runContainer.ok) {
    return refuse(`the run container did not start: ${runContainer.error.detail}`);
  }

  const unreachable = await proxyUnreachableDetail(engine, runContainer.value, proxy.value.name);
  if (unreachable !== null) {
    return refuse(`the run container cannot reach its proxy: ${unreachable}`);
  }

  const unenforceable = whyNotEnforced ?? (await probeRunNetwork(engine, runContainer.value, scope.network) === 'reached'
    ? 'a connection from inside the run container reached an address outside, or the Docker host, without the proxy'
    : null);
  if (unenforceable !== null) {
    log({ code: 'egress-unenforceable', detail: unenforceable });
  }
  const ids = { runId: scope.runId, proxyId: proxy.value.id, runContainerId: runContainer.value };
  return success(runnerHandleFor(setup, ids, unenforceable === null ? 'isolated' : 'host', removeAll));
}

export function dockerRunner(options: DockerRunnerOptions): Runner {
  const { engine } = options;
  const root = options.repositoryRoot;
  const log: RunnerLog = options.log ?? ((): void => undefined);
  const ownMounts = ownCodeMounts(root, dependenciesVolumeFor(options.dependenciesVolume));
  let latestRun: RunnerHandle | null = null;

  async function start(image: ImageDigest, policy: EgressPolicy): Promise<Result<RunnerHandle, RunnerError>> {
    latestRun = null;
    const refusal = await pinRunImage(engine, image, log);
    if (refusal !== null) {
      return failure(refusal);
    }
    const inputs = repositoryInputs(options.inputs ?? [], log);
    if (inputs === null) {
      return failure({ code: 'start-failed' });
    }
    const setup: RunSetup = { engine, root, log, image, policy, services: options.services, inputs, ownMounts };
    const started = await keepingContainerScope(engine, `${PRODUCT.name}-run`, (scope, removeAll) => startRunInScope(setup, scope, removeAll));
    if (started.ok) {
      latestRun = started.value;
    }
    return started;
  }

  return {
    start,
    guaranteeLevel: () => latestRun?.guaranteeLevel() ?? 'host',
  };
}
