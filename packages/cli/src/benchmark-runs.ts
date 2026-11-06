// The performance benchmark's runs: the sign-up plan, run on the CDP driver's headless shell
// against the sign-up fixture app, a number of times. Each run gives its setup time, from calling
// run to the first step.start, and its peak memory, the highest combined resident memory of Node
// and every process it started (Chromium), sampled from /proc every 100 ms. tools/benchmark.ts
// calls this and compares the medians with the stored Linux baseline; it is never a gate.
import {
  defaultRedactor, failure, HOST_ISOLATION, loadTrustedProject, parseBaseUrl, planParser, policyGate, run, sha256, success,
  type ArtifactReference, type ArtifactStore, type Clock, type EventSink, type FixtureReference, type LoggedEvent, type RunEventSink,
  type VersionControlPort,
} from '@revisum/engine';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { arch, platform } from 'node:os';
import { extname, join } from 'node:path';
import { buildAdapters } from './BuildAdapters.ts';

export type BenchmarkSample = { readonly setupMilliseconds: number; readonly peakMemoryMegabytes: number };
export type BenchmarkRunsOptions = {
  readonly repositoryRoot: string;
  // The headless shell's executable.
  readonly executablePath: string;
  readonly runs: number;
};
export type BenchmarkRuns = { readonly platform: string; readonly runs: readonly BenchmarkSample[] };

const TARGET_ID = 'cdp-chromium-headless-shell';
const SAMPLE_INTERVAL_MILLISECONDS = 100;
const MEGABYTE = 1024 * 1024;

// The sign-up plan the driver contract runs, without its captures, on the headless shell.
const SIGNUP_PLAN = {
  version: '1.3',
  meta: { featureId: 'SIGNUP-1', specReference: 'specs/signup.md#happy-path', title: 'Sign-up happy path' },
  targets: [TARGET_ID],
  steps: [
    { type: 'navigate', url: '/' },
    { type: 'expect', locator: { by: 'role', role: 'heading', name: 'Create your account' }, assert: { kind: 'visible' }, criterionId: 'signup.heading-shown' },
    { type: 'fill', locator: { by: 'label', label: 'Full name' }, value: 'Ada Lovelace' },
    { type: 'fill', locator: { by: 'label', label: 'Email' }, value: 'ada@example.test' },
    { type: 'click', locator: { by: 'role', role: 'checkbox', name: 'I agree to the terms' } },
    { type: 'click', locator: { by: 'role', role: 'button', name: 'Create account' } },
    { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'textContains', value: 'Welcome' }, criterionId: 'signup.welcome-shown' },
  ],
};

const projectFileFor = (origin: string): unknown => ({
  origins: [origin],
  limits: { stepTimeoutMilliseconds: 10_000 },
  matrix: [{
    id: TARGET_ID, adapter: 'cdp', engine: 'chromium', device: 'desktop-1280', locale: 'en-GB', timezone: 'UTC',
    colorScheme: 'light', reducedMotion: 'reduce',
  }],
});

// A protected branch holding only the benchmark's own project file, so the project is trusted the
// way core trusts any project.
function protectedBranchWith(projectFile: unknown): VersionControlPort {
  return {
    protectedBranch: 'main',
    async protectedFile(path) {
      return path === 'project.json'
        ? success({ bytes: new TextEncoder().encode(JSON.stringify(projectFile)), commit: 'benchmark' })
        : failure('not-found');
    },
    reviews: async () => failure('unavailable'),
    changedFiles: async () => failure('unavailable'),
    pullRequest: async () => failure('unavailable'),
    lastCommitTouching: async () => failure('unavailable'),
    landedBy: async () => failure('unavailable'),
  };
}

const discardingAudit: EventSink = { append: () => success({ sequence: 0 }) };

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};

// Serves the fixture app's files on loopback, and lists them by content hash for the manifest.
async function serveFixtures(folder: string): Promise<{ readonly server: Server; readonly origin: string; readonly fixtures: FixtureReference[] }> {
  const files = new Map(readdirSync(folder).map((name) => [`/${name}`, readFileSync(join(folder, name))]));
  const server = createServer((request, response) => {
    const path = request.url === '/' ? '/index.html' : (request.url ?? '').split('?')[0] ?? '';
    const body = files.get(path);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': MEDIA_TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const fixtures = [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })).sort((left, right) => (left.path < right.path ? -1 : 1));
  return { server, origin: `http://127.0.0.1:${port}`, fixtures };
}

// The resident memory of this process and every process below it, in bytes, read from /proc. On a
// system without /proc, only this process's own.
function treeResidentBytes(): number {
  const own = process.memoryUsage.rss();
  if (!existsSync('/proc/self/stat')) return own;
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // The parent id is the second field after the command, which sits in parentheses.
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(name), Number(fields[1]));
    } catch {
      // A process that ended while being read is not counted.
    }
  }
  const tree = new Set([process.pid]);
  for (let grown = true; grown;) {
    grown = false;
    for (const [id, parent] of parents) if (!tree.has(id) && tree.has(parent)) { tree.add(id); grown = true; }
  }
  let total = own;
  for (const id of tree) {
    if (id === process.pid) continue;
    try {
      const resident = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${id}/status`, 'utf8'))?.[1];
      total += resident === undefined ? 0 : Number(resident) * 1024;
    } catch {
      // As above.
    }
  }
  return total;
}

const memoryArtifacts = (): ArtifactStore => ({
  async put(name, bytes, mediaType): Promise<ArtifactReference> {
    return { name, mediaType, sha256: sha256(bytes), bytes: bytes.length };
  },
});

const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function benchmarkRuns(options: BenchmarkRunsOptions): Promise<BenchmarkRuns> {
  const { server, origin, fixtures } = await serveFixtures(join(options.repositoryRoot, 'fixtures', 'signup-app'));
  try {
    const projectFile = projectFileFor(origin);
    // The gate clears the plan under the trusted project, and the run runs under the project it cleared.
    const loaded = await loadTrustedProject('project.json', protectedBranchWith(projectFile), { files: [], events: discardingAudit });
    if (!loaded.ok) throw new Error(`the benchmark project was refused: ${JSON.stringify(loaded.error)}`);
    const project = loaded.value.project;
    const parsed = planParser(project)(SIGNUP_PLAN);
    if (!parsed.ok) throw new Error(`the benchmark plan was rejected: ${JSON.stringify(parsed.error)}`);
    const target = project.matrix.find((candidate) => candidate.id === TARGET_ID);
    if (target === undefined) throw new Error('the benchmark project has no headless-shell target');
    const baseUrl = parseBaseUrl(origin);
    if (!baseUrl.ok) throw new Error(`the fixture server's origin is not a base URL: ${baseUrl.error}`);
    const decision = policyGate({ project, events: discardingAudit }).clear(parsed.value, target.id);
    if (decision.kind === 'deny') throw new Error(`the policy gate denied the benchmark plan: ${decision.rule}`);
    if (decision.kind === 'not-declared') {
      throw new Error(`the benchmark plan does not declare the target ${target.id}`);
    }
    const drivers = new Map([['cdp', buildAdapters.hostBrowserDriver({ executablePath: options.executablePath })]]);
    const samples: BenchmarkSample[] = [];
    for (let index = 0; index < options.runs; index++) {
      // Set by the event sink, which the run calls back.
      const timing: { firstStep: number | null } = { firstStep: null };
      const events: LoggedEvent[] = [];
      const sink: RunEventSink = {
        append(event) {
          if (timing.firstStep === null && event.kind === 'step.start') timing.firstStep = performance.now();
          events.push(event);
        },
        read: () => [...events],
      };
      let peak = treeResidentBytes();
      const sampler = setInterval(() => { peak = Math.max(peak, treeResidentBytes()); }, SAMPLE_INTERVAL_MILLISECONDS);
      const started = performance.now();
      try {
        const result = await run(decision.run, {
          baseUrl: baseUrl.value, seed: 42, fixedTimeMilliseconds: Date.UTC(2026, 0, 15, 10, 30), fixtures, host: { platform: platform(), arch: arch() },
        }, { drivers, clock: systemClock, artifacts: memoryArtifacts(), redactor: defaultRedactor(), audit: discardingAudit, events: sink, isolation: HOST_ISOLATION });
        if (result.state !== 'Passed') throw new Error(`benchmark run ${index + 1} ended ${result.state}`);
      } finally {
        clearInterval(sampler);
      }
      peak = Math.max(peak, treeResidentBytes());
      if (timing.firstStep === null) throw new Error(`benchmark run ${index + 1} started no step`);
      samples.push({ setupMilliseconds: Math.round(timing.firstStep - started), peakMemoryMegabytes: Math.round(peak / MEGABYTE) });
    }
    return { platform: `${platform()}-${arch()}`, runs: samples };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
