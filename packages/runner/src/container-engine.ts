// The container engine port, and its Docker implementation. The runner asks the engine for what
// it needs (an image's id, a network, a hardened container, a command run inside one), so unit
// tests can answer with a fake. Docker is driven through its command-line client, started with
// spawn and never through a shell, so no argument is ever read as shell syntax; no Docker library
// is needed. See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { failure, success, type ExecOutcome, type Result } from '@revisum/contracts';
import { spawn } from 'node:child_process';

// A host folder, a single host file or a named volume, always mounted read-only.
export type ContainerMount = { readonly kind: 'folder' | 'file' | 'volume'; readonly source: string; readonly target: string };

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
};

export type EngineProblem = { readonly detail: string };
export type ProbeTarget = { readonly host: string; readonly port: number };

export interface ContainerEngine {
  // The id ("sha256:…") of the local image with this reference, or null when there is none.
  imageId(reference: string): Promise<string | null>;
  // internal: a network with no route out of the host.
  createNetwork(name: string, options: { readonly internal: boolean }): Promise<Result<void, EngineProblem>>;
  removeNetwork(name: string): Promise<void>;
  // Starts a container and returns its id.
  startContainer(options: ContainerOptions): Promise<Result<string, EngineProblem>>;
  // Runs an argument vector inside a running container, without a shell.
  exec(containerId: string, command: readonly string[]): Promise<Result<ExecOutcome, EngineProblem>>;
  // Tries a direct connection from inside the container to each target. 'reached' when any one
  // answered, or when the probe itself could not run, so an unknown is never taken for 'blocked'.
  probeEgress(containerId: string, targets: readonly ProbeTarget[]): Promise<'reached' | 'blocked'>;
  // Removes a container, running or not.
  removeContainer(containerId: string): Promise<void>;
}

// Output beyond this is dropped, so a chatty command cannot exhaust memory.
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DOCKER_COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const PROBE_TIMEOUT_MILLISECONDS = 4_000;

export type DockerOutcome = { readonly status: number; readonly stdout: string; readonly stderr: string };

// Runs the Docker client with these arguments, without a shell. Status -1 means it could not run
// or ran out of time.
export function runDocker(words: readonly string[], timeoutMilliseconds: number | null = DOCKER_COMMAND_TIMEOUT_MILLISECONDS): Promise<DockerOutcome> {
  return new Promise((resolve) => {
    const child = spawn('docker', [...words], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let kept = 0;
    const keep = (into: Buffer[]) => (chunk: Buffer): void => {
      if (kept >= OUTPUT_LIMIT_BYTES) return;
      kept += chunk.length;
      into.push(chunk);
    };
    child.stdout.on('data', keep(stdout));
    child.stderr.on('data', keep(stderr));
    const timer = timeoutMilliseconds === null ? undefined : setTimeout(() => child.kill(), timeoutMilliseconds);
    const finish = (status: number, extra = ''): void => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `${Buffer.concat(stderr).toString('utf8')}${extra}` });
    };
    child.once('error', (error) => finish(-1, error.message));
    child.once('close', (code) => finish(code ?? -1));
  });
}

const problem = (outcome: DockerOutcome): EngineProblem => ({ detail: (outcome.stderr.trim() || outcome.stdout.trim()).slice(0, 500) });

function mountArgument(mount: ContainerMount): string {
  const type = mount.kind === 'volume' ? 'volume' : 'bind';
  return `type=${type},source=${mount.source},target=${mount.target},readonly`;
}

// The Docker arguments that create, but do not start, a hardened container.
export function createArguments(options: ContainerOptions): readonly string[] {
  const [firstNetwork = 'none'] = options.networks;
  return [
    'create', '--name', options.name, '--network', firstNetwork,
    '--user', options.user,
    '--security-opt', `seccomp=${options.seccompProfile}`, '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1024m', '--shm-size', '512m',
    '--workdir', options.workingFolder,
    ...Object.entries(options.environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    ...options.mounts.flatMap((mount) => ['--mount', mountArgument(mount)]),
    options.image, ...options.command,
  ];
}

// Prints "reached" when a direct connection to any target succeeds within the timeout, else "blocked".
const probeScript = (targets: readonly ProbeTarget[]): string => `
  const { connect } = require('node:net');
  const targets = ${JSON.stringify(targets)};
  let open = targets.length;
  const done = (outcome) => { console.log(outcome); process.exit(0); };
  for (const target of targets) {
    const socket = connect({ host: target.host, port: target.port });
    const settle = () => { socket.destroy(); open -= 1; if (open === 0) done('blocked'); };
    socket.setTimeout(${PROBE_TIMEOUT_MILLISECONDS}, settle);
    socket.on('error', settle);
    socket.on('connect', () => done('reached'));
  }
  if (open === 0) done('blocked');`;

// The container engine over the Docker command-line client.
export function dockerCliEngine(): ContainerEngine {
  const exec = async (containerId: string, command: readonly string[]): Promise<Result<ExecOutcome, EngineProblem>> => {
    const outcome = await runDocker(['exec', containerId, ...command], null);
    if (outcome.status === -1) return failure(problem(outcome));
    return success({ exitCode: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr });
  };
  const removeContainer = async (containerId: string): Promise<void> => {
    await runDocker(['rm', '--force', '--volumes', containerId]);
  };
  return {
    async imageId(reference) {
      const outcome = await runDocker(['image', 'inspect', '--format', '{{.Id}}', reference]);
      const id = outcome.stdout.trim();
      return outcome.status === 0 && id !== '' ? id : null;
    },
    async createNetwork(name, options) {
      const outcome = await runDocker(['network', 'create', ...(options.internal ? ['--internal'] : []), name]);
      return outcome.status === 0 ? success(undefined) : failure(problem(outcome));
    },
    async removeNetwork(name) {
      await runDocker(['network', 'rm', name]);
    },
    async startContainer(options) {
      const created = await runDocker(createArguments(options));
      if (created.status !== 0) return failure(problem(created));
      const containerId = created.stdout.trim();
      for (const network of options.networks.slice(1)) {
        const joined = await runDocker(['network', 'connect', network, containerId]);
        if (joined.status !== 0) {
          await removeContainer(containerId);
          return failure(problem(joined));
        }
      }
      const started = await runDocker(['start', containerId]);
      if (started.status !== 0) {
        await removeContainer(containerId);
        return failure(problem(started));
      }
      return success(containerId);
    },
    exec,
    async probeEgress(containerId, targets) {
      const probed = await exec(containerId, ['node', '-e', probeScript(targets)]);
      if (!probed.ok || probed.value.exitCode !== 0) return 'reached';
      return probed.value.stdout.trim().split('\n').at(-1) === 'blocked' ? 'blocked' : 'reached';
    },
    removeContainer,
  };
}
