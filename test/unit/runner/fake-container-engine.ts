// A container engine that starts nothing. It answers the runner as Docker would on a host with the
// given settings, and records every call, so a test can see what the runner asked for: which
// networks and containers it created, what it ran inside them, and whether it started anything.
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
  // The id each image reference has, when it differs from localImageId; null means no such image.
  // The workload runner looks up both Revisum's run image and the team's image, so a test can say
  // which one is missing or different.
  readonly images?: Readonly<Record<string, string | null>>;
  // Containers for which this returns true fail to start, as a proxy container would whose image
  // or command is broken.
  readonly failsToStart?: (options: ContainerOptions) => boolean;
};

export type FakeContainerEngine = ContainerEngine & {
  // The name of each engine method called, in order.
  readonly calls: readonly string[];
  // The options of every container started.
  readonly started: readonly ContainerOptions[];
  // Every network created, with whether it was asked to have no route out.
  readonly createdNetworks: readonly { readonly name: string; readonly internal: boolean }[];
  // Every command run inside a container through exec, with the container it ran in.
  readonly executed: readonly { readonly containerId: string; readonly command: readonly string[] }[];
  // Containers and networks created and not yet removed.
  runningContainers(): readonly string[];
  existingNetworks(): readonly string[];
};

export const ENGINE_STARTING_CALLS: readonly string[] = ['createNetwork', 'startContainer', 'exec', 'probeEgress'];

export function fakeContainerEngine(settings: FakeEngineSettings): FakeContainerEngine {
  const calls: string[] = [];
  const started: ContainerOptions[] = [];
  const createdNetworks: { readonly name: string; readonly internal: boolean }[] = [];
  const executed: { readonly containerId: string; readonly command: readonly string[] }[] = [];
  const running = new Set<string>();
  const networks = new Set<string>();
  return {
    calls, started, createdNetworks, executed,
    runningContainers: () => [...running],
    existingNetworks: () => [...networks],
    async imageId(reference) {
      calls.push('imageId');
      const images = settings.images ?? {};
      return Object.hasOwn(images, reference) ? images[reference] ?? null : settings.localImageId;
    },
    async createNetwork(name, options) {
      calls.push('createNetwork');
      if (options.internal && !settings.internalNetworks) return failure({ detail: 'this Docker cannot create an internal network' });
      createdNetworks.push({ name, internal: options.internal });
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
      if (settings.failsToStart?.(options) === true) return failure({ detail: 'the container exited as it started' });
      const id = `fake-container-${started.length}`;
      running.add(id);
      return success(id);
    },
    async exec(containerId, command) {
      calls.push('exec');
      executed.push({ containerId, command: [...command] });
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
