// A container engine that starts nothing. It answers the runner as Docker would on a host with the
// given settings, and records every call, so a test can see what the runner asked for: which
// networks and containers it created, and whether it started anything at all.
import { failure, success } from '@revisum/contracts';
import type { ContainerEngine, ContainerOptions } from '@revisum/runner';

export type FakeEngineSettings = {
  // The id ("sha256:…") of the local run image, or null when there is none.
  readonly localImageId: string | null;
  // False on a host that cannot create a network with no route out, such as a CI provider whose
  // Docker refuses --internal.
  readonly internalNetworks: boolean;
  // What the probe from inside the run container to an undeclared address outside finds.
  readonly probe: 'reached' | 'blocked';
};

export type FakeContainerEngine = ContainerEngine & {
  // The name of each engine method called, in order.
  readonly calls: readonly string[];
  // The options of every container started.
  readonly started: readonly ContainerOptions[];
  // Containers and networks created and not yet removed.
  runningContainers(): readonly string[];
  existingNetworks(): readonly string[];
};

export const ENGINE_STARTING_CALLS: readonly string[] = ['createNetwork', 'startContainer', 'exec', 'probeEgress'];

export function fakeContainerEngine(settings: FakeEngineSettings): FakeContainerEngine {
  const calls: string[] = [];
  const started: ContainerOptions[] = [];
  const running = new Set<string>();
  const networks = new Set<string>();
  return {
    calls, started,
    runningContainers: () => [...running],
    existingNetworks: () => [...networks],
    async imageId() {
      calls.push('imageId');
      return settings.localImageId;
    },
    async createNetwork(name, options) {
      calls.push('createNetwork');
      if (options.internal && !settings.internalNetworks) return failure({ detail: 'this Docker cannot create an internal network' });
      networks.add(name);
      return success(undefined);
    },
    async removeNetwork(name) {
      calls.push('removeNetwork');
      networks.delete(name);
    },
    async startContainer(options) {
      calls.push('startContainer');
      started.push(options);
      const id = `fake-container-${started.length}`;
      running.add(id);
      return success(id);
    },
    async exec() {
      calls.push('exec');
      return success({ exitCode: 0, stdout: '', stderr: '' });
    },
    async probeEgress() {
      calls.push('probeEgress');
      return settings.probe;
    },
    async removeContainer(containerId) {
      calls.push('removeContainer');
      running.delete(containerId);
    },
  };
}
