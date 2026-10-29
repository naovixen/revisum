// The isolated runner on a container engine. A run gets its own Docker network with no route out
// (--internal), a run container that joins only that network, and a proxy container, from the same
// image, that joins it and the default bridge and runs the egress proxy. The browser is pointed at
// the proxy, so a request that bypasses it has nowhere to go.
//
// The runner claims the isolated guarantee level only once all three have started and a direct
// connection from inside the run container to an address outside has failed. Otherwise the run
// still starts, at the host level, and logs egress-unenforceable, so no report claims isolation.
// Nothing reaches the containers from the host's environment: each environment is built from an
// empty list, and only the code, dependencies and browsers the run needs are mounted, read-only.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import {
  PRODUCT, failure, success,
  type DeclaredService, type EgressPolicy, type ExecOutcome, type GuaranteeLevel, type ImageDigest, type ProxyDecision, type Result, type Runner, type RunnerError,
  type RunnerHandle,
} from '@revisum/contracts';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ContainerEngine, ContainerMount } from './container-engine.ts';
import { joinEgressEvents } from './egress-events.ts';
import {
  DEFAULT_BRIDGE_NETWORK, OUTSIDE_PROBE_TARGETS, WORKSPACE, dependenciesVolumeFor, proxyContainer, proxyReadyScript, proxyUrl, readDecisions,
  repositoryFolder, revisumMounts, runImageContainer,
} from './run-containers.ts';
import { RUN_IMAGE_TAG } from './run-image.ts';

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

export function dockerRunner(options: DockerRunnerOptions): Runner {
  const engine = options.engine;
  const root = options.repositoryRoot;
  const log = options.log ?? ((): void => undefined);
  const dependenciesVolume = dependenciesVolumeFor(options.dependenciesVolume);
  let level: GuaranteeLevel = 'host';

  const sharedMounts = (): ContainerMount[] => revisumMounts(root, dependenciesVolume);

  async function start(image: ImageDigest, policy: EgressPolicy): Promise<Result<RunnerHandle, RunnerError>> {
    level = 'host';
    const localId = await engine.imageId(RUN_IMAGE_TAG);
    if (localId === null) return failure({ code: 'image-missing' });
    if (localId !== image) return failure({ code: 'image-digest-mismatch' });
    const inputs: string[] = [];
    for (const input of options.inputs ?? []) {
      const folder = repositoryFolder(input);
      if (folder === null) {
        log({ code: 'start-failed', detail: `the input ${input} is not a folder inside the repository` });
        return failure({ code: 'start-failed' });
      }
      inputs.push(folder);
    }

    const runId = `${PRODUCT.name}-run-${randomBytes(6).toString('hex')}`;
    const network = `${runId}-network`;
    const containers: string[] = [];
    let networkCreated = false;
    const removeAll = async (): Promise<void> => {
      for (const containerId of containers.splice(0).reverse()) await engine.removeContainer(containerId);
      if (networkCreated) await engine.removeNetwork(network);
      networkCreated = false;
    };
    const refuse = async (detail: string): Promise<Result<RunnerHandle, RunnerError>> => {
      log({ code: 'start-failed', detail });
      await removeAll();
      return failure({ code: 'start-failed' });
    };

    // A network with no route out is what enforces egress. Where Docker cannot make one, the run
    // goes ahead on an ordinary network, at the host level.
    const internal = await engine.createNetwork(network, { internal: true });
    let unenforceable: string | null = null;
    if (internal.ok) {
      networkCreated = true;
    } else {
      unenforceable = `Docker could not create a network with no route out: ${internal.error.detail}`;
      const ordinary = await engine.createNetwork(network, { internal: false });
      if (!ordinary.ok) return refuse(`Docker could not create the run's network: ${ordinary.error.detail}`);
      networkCreated = true;
    }

    const proxyName = `${runId}-proxy`;
    const proxy = await engine.startContainer(proxyContainer(root, {
      name: proxyName, image, networks: unenforceable === null ? [network, DEFAULT_BRIDGE_NETWORK] : [network],
      policy, services: options.services, mounts: sharedMounts(),
    }));
    if (!proxy.ok) return refuse(`the proxy container did not start: ${proxy.error.detail}`);
    containers.push(proxy.value);
    const proxyId = proxy.value;

    const proxyAddress = proxyUrl(proxyName);
    const runEnvironment = {
      HOME: '/tmp', HTTP_PROXY: proxyAddress, HTTPS_PROXY: proxyAddress, NO_PROXY: 'localhost,127.0.0.1,::1',
      'http_proxy': proxyAddress, 'https_proxy': proxyAddress, 'no_proxy': 'localhost,127.0.0.1,::1',
    };
    const runMounts: ContainerMount[] = [
      ...sharedMounts(),
      { kind: 'folder', source: join(root, '.browsers'), target: `${WORKSPACE}/.browsers` },
      ...inputs.map((input): ContainerMount => ({ kind: 'folder', source: join(root, input), target: `${WORKSPACE}/${input}` })),
    ];
    const runContainer = await engine.startContainer(runImageContainer(root, {
      name: `${runId}-run`, image, networks: [network], environment: runEnvironment, mounts: runMounts, command: ['sleep', 'infinity'],
    }));
    if (!runContainer.ok) return refuse(`the run container did not start: ${runContainer.error.detail}`);
    containers.push(runContainer.value);
    const runContainerId = runContainer.value;

    const ready = await engine.exec(runContainerId, ['node', '-e', proxyReadyScript(proxyName)]);
    if (!ready.ok || ready.value.exitCode !== 0) {
      return refuse(`the run container cannot reach its proxy: ${ready.ok ? ready.value.stderr.trim() : ready.error.detail}`);
    }

    if (unenforceable === null && await engine.probeEgress(runContainerId, OUTSIDE_PROBE_TARGETS) === 'reached') {
      unenforceable = 'a connection from inside the run container reached an address outside without the proxy';
    }
    if (unenforceable === null) level = 'isolated';
    else log({ code: 'egress-unenforceable', detail: unenforceable });

    let decisions: readonly ProxyDecision[] = [];
    // Reads the proxy's decisions back from its container.
    const refreshDecisions = async (): Promise<void> => {
      decisions = await readDecisions(engine, proxyId) ?? decisions;
    };
    let stopped = false;
    const handle: RunnerHandle = {
      runId,
      egressEvents: () => joinEgressEvents([], decisions),
      async exec(command): Promise<ExecOutcome> {
        const outcome = await engine.exec(runContainerId, command);
        await refreshDecisions();
        return outcome.ok ? outcome.value : { exitCode: -1, stdout: '', stderr: outcome.error.detail };
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        await refreshDecisions();
        await removeAll();
      },
    };
    return success(handle);
  }

  return {
    start,
    guaranteeLevel: () => level,
  };
}
