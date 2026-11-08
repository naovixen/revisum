// A container engine that starts nothing. It answers the runner as Docker would on a host with the
// given settings, and records every call, so a test can see what the runner asked for: which
// networks and containers it created, what it ran inside them, and whether it started anything.
// Any method can be answered differently through the same settings: a test gives that method, and
// the fake still records the call and keeps its lists of what exists.
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
} & Partial<ContainerEngine>;

export type FakeContainerEngine = ContainerEngine & {
  // The name of each engine method called, in order.
  readonly calls: readonly string[];
  // The options of every container started.
  readonly started: readonly ContainerOptions[];
  // Every network created, with whether it was asked to have no route out.
  readonly createdNetworks: readonly { readonly name: string; readonly internal: boolean }[];
  // Every command run inside a container through exec, with the container it ran in.
  readonly executed: readonly { readonly containerId: string; readonly command: readonly string[] }[];
  // Each container id and network name asked to be removed, in the order asked.
  readonly removals: readonly string[];
  // Containers and networks created and not yet removed.
  runningContainers(): readonly string[];
  existingNetworks(): readonly string[];
};

export const ENGINE_STARTING_CALLS: readonly string[] = ['createNetwork', 'startContainer', 'exec', 'probeEgress'];

// Where the fake says a gateway would be, so a run's gateway probe happens unless a test says otherwise.
const FIRST_ADDRESS_OF_THE_NETWORK = '172.18.0.1';

// The engine methods that only answer what the host is like, each recorded.
type HostAnswers = Pick<ContainerEngine, 'imageId' | 'daemonProblem' | 'networkGatewayAddress' | 'probeEgress' | 'imageUser' | 'containerAddress'>;

function hostAnswers(settings: FakeEngineSettings, calls: string[]): HostAnswers {
  return {
    async imageId(reference) {
      calls.push('imageId');
      if (settings.imageId !== undefined) {
        return settings.imageId(reference);
      }
      const images = settings.images ?? {};
      const id = Object.hasOwn(images, reference) ? images[reference] ?? null : settings.localImageId;
      return id === null ? { kind: 'absent' } : { kind: 'found', id };
    },
    async daemonProblem() {
      calls.push('daemonProblem');
      return settings.daemonProblem === undefined ? null : settings.daemonProblem();
    },
    async networkGatewayAddress(network) {
      calls.push('networkGatewayAddress');
      return settings.networkGatewayAddress === undefined ? success(FIRST_ADDRESS_OF_THE_NETWORK) : settings.networkGatewayAddress(network);
    },
    async probeEgress(containerId, targets) {
      calls.push('probeEgress');
      return settings.probeEgress === undefined ? settings.probe : settings.probeEgress(containerId, targets);
    },
  };
}

export function fakeContainerEngine(settings: FakeEngineSettings): FakeContainerEngine {
  const calls: string[] = [];
  const started: ContainerOptions[] = [];
  const createdNetworks: { readonly name: string; readonly internal: boolean }[] = [];
  const executed: { readonly containerId: string; readonly command: readonly string[] }[] = [];
  const removals: string[] = [];
  const running = new Set<string>();
  const networks = new Set<string>();
  return {
    ...hostAnswers(settings, calls),
    calls, started, createdNetworks, executed, removals,
    runningContainers: () => [...running],
    existingNetworks: () => [...networks],
    async createNetwork(name, options) {
      calls.push('createNetwork');
      if (settings.createNetwork !== undefined) {
        const created = await settings.createNetwork(name, options);
        if (created.ok) {networks.add(name);}
        return created;
      }
      if (options.internal && !settings.internalNetworks) {return failure({ detail: 'this Docker cannot create an internal network' });}
      createdNetworks.push({ name, internal: options.internal });
      networks.add(name);
      return success(undefined);
    },
    async removeNetwork(name) {
      calls.push('removeNetwork');
      removals.push(name);
      const removed = settings.removeNetwork === undefined ? success(undefined) : await settings.removeNetwork(name);
      if (removed.ok) {networks.delete(name);}
      return removed;
    },
    async startContainer(options) {
      calls.push('startContainer');
      started.push(options);
      if (settings.startContainer !== undefined) {
        const answered = await settings.startContainer(options);
        if (answered.ok) {running.add(answered.value);}
        return answered;
      }
      if (settings.failsToStart?.(options) === true) {return failure({ detail: 'the container exited as it started' });}
      const id = `fake-container-${started.length}`;
      running.add(id);
      return success(id);
    },
    async exec(containerId, command, environmentNames) {
      calls.push('exec');
      executed.push({ containerId, command: [...command] });
      return settings.exec === undefined ? success({ exitCode: 0, stdout: '', stderr: '' }) : settings.exec(containerId, command, environmentNames);
    },
    async removeContainer(containerId) {
      calls.push('removeContainer');
      removals.push(containerId);
      const removed = settings.removeContainer === undefined ? success(undefined) : await settings.removeContainer(containerId);
      if (removed.ok) {running.delete(containerId);}
      return removed;
    },
    async imageUser(reference) {
      calls.push('imageUser');
      return settings.imageUser === undefined ? null : settings.imageUser(reference);
    },
    async containerAddress(containerId, network) {
      calls.push('containerAddress');
      return settings.containerAddress === undefined ? null : settings.containerAddress(containerId, network);
    },
  };
}
