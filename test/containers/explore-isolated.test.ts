// Explore mode in the real isolated runner: `revisum draft --explore <url> --json`, with no --host.
// The draft command starts a run container on Docker whose egress proxy may reach the start origin
// alone, and the crawl runs inside it through packages/cli/src/explore-in-container.ts.
//   - The page map the container prints is the one the host-mode tests pin
//     (golden/page-maps/explore-site.pages.json), apart from its origin, and says isolated; the
//     output says egress was enforced (AC-11, AC-03).
//   - The cross-origin and production links on the home page are never requested: the second
//     server hears nothing, and the proxy allowed nothing but the start origin (AC-01).
//   - With an approved --after login plan that types a secret, the secret's value is on no docker
//     command line, and in no page map, draft, output or event (AC-09).
//
// The Lantern Books site is served inside the run container, on its own loopback, by
// explore-site-inside.ts: a site on this machine would be a private address, which the proxy
// refuses. The real runner is watched, not replaced: the watch starts the site once the container
// is up, records each exec and its output, and, before the run stops, reads what the site's servers
// heard and the proxy's decisions. Every docker command line is recorded from the spawn of the
// Docker client itself. The runner removes the containers and network it created.
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { before, test } from 'node:test';
import {
  success, type EgressEvent, type EgressPolicy, type ExecOutcome, type ImageDigest, type Runner, type RunnerHandle,
} from '@revisum/contracts';
import { dockerCliEngine, dockerRunner } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import {
  AFTER_PLAN_PATH, GOLDEN_PAGE_MAP, LOGIN_NAME_SECRET, OFFICE_KEY_NAME, OFFICE_KEY_VALUE, PRODUCTION_ORIGIN, SIGN_IN_PLAN, SITE_PLACEHOLDER,
  allWrittenNodes, approvalOfPlan, crawlOrder, everythingExplored, exploreArguments, exploreData, exploreErrorCodes, exploreSecrets, pageMapText,
  withExploreRun, writtenMap, type ExploreSetup, type ExploreSite, type WrittenMap,
} from '../unit/cli/explore-command-examples.ts';
import { letterNonce } from '../unit/engine/secret-examples.ts';
import { hostOf } from '../unit/runner/runner-examples.ts';
import {
  INSIDE_SECOND_ORIGIN, INSIDE_SITE_ORIGIN, INSIDE_SITE_PORT, REQUESTS_FILE, SITE_MODULE,
} from './explore-site-inside.ts';
import { dockerIds, newIds, pinnedRunImage } from './isolated-run.ts';

const TIMEOUT = 600_000;
const START = `${INSIDE_SITE_ORIGIN}/`;
const PRODUCTION_HOST = hostOf(PRODUCTION_ORIGIN);
const CRAWL_MODULE = 'packages/cli/src/explore-in-container.ts';

// ---- Every docker command line, from the spawn of the Docker client ---------------------------------

// The runner starts the Docker client with child_process.spawn. Replacing spawn on the module's
// CommonJS exports and syncing the built-in ES module bindings lets the test see each argument
// list exactly as the client receives it, then hands the call on unchanged.
const childProcess: object = createRequire(import.meta.url)('node:child_process');

type CommandLineSpy = { readonly lines: readonly (readonly string[])[]; restore(): void };

function spyOnDockerCommandLines(): CommandLineSpy {
  const original: unknown = Reflect.get(childProcess, 'spawn');
  assert.ok(typeof original === 'function', 'child_process has no spawn');
  const lines: (readonly string[])[] = [];
  Reflect.set(childProcess, 'spawn', (...inputs: readonly unknown[]) => {
    const [command, words] = inputs;
    if (command === 'docker' && Array.isArray(words)) lines.push(['docker', ...words.map(String)]);
    return Reflect.apply(original, childProcess, inputs);
  });
  syncBuiltinESMExports();
  return {
    lines,
    restore() {
      Reflect.set(childProcess, 'spawn', original);
      syncBuiltinESMExports();
    },
  };
}

// ---- The real runner, watched ---------------------------------------------------------------------------

type SiteRequest = { readonly server: 'site' | 'second'; readonly path: string };

type RunnerWatch = {
  readonly policies: EgressPolicy[];
  readonly execs: { readonly command: readonly string[]; readonly environmentNames: readonly string[]; readonly outcome: ExecOutcome }[];
  // The proxy's decisions once the crawl had ended, and again after the counter-example's request.
  crawlEgress: readonly EgressEvent[];
  probeEgress: readonly EgressEvent[];
  requests: readonly SiteRequest[];
};

// Starts the site in the background inside the run container, and waits until it answers.
const startSiteScript = `
  const { spawn } = require('node:child_process');
  const { connect } = require('node:net');
  spawn(process.execPath, [${JSON.stringify(SITE_MODULE)}], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 60000;
  const attempt = () => {
    const socket = connect({ host: '127.0.0.1', port: ${INSIDE_SITE_PORT} });
    socket.on('connect', () => { socket.destroy(); console.log('ready'); process.exit(0); });
    socket.on('error', () => {
      socket.destroy();
      if (Date.now() > deadline) { console.log('the site did not start'); process.exit(1); }
      setTimeout(attempt, 200);
    });
  };
  attempt();`;

const readRequestsScript = `
  const { existsSync, readFileSync } = require('node:fs');
  const file = ${JSON.stringify(REQUESTS_FILE)};
  console.log(JSON.stringify(existsSync(file) ? readFileSync(file, 'utf8') : ''));`;

// The counter-example's request: through the run's proxy, for the production link's host.
const productionRequestScript = `
  const proxy = new URL(process.env.HTTP_PROXY);
  const request = require('node:http').request({
    host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: 'http://${PRODUCTION_HOST}/checkout', headers: { host: '${PRODUCTION_HOST}' },
  }, (response) => { response.resume(); response.on('end', () => { console.log(JSON.stringify(response.statusCode)); process.exit(0); }); });
  request.setTimeout(10000, () => { console.log(JSON.stringify('timed out')); process.exit(0); });
  request.on('error', (error) => { console.log(JSON.stringify(String(error))); process.exit(0); });
  request.end();`;

function parsedRequests(outcome: ExecOutcome): readonly SiteRequest[] {
  assert.equal(outcome.exitCode, 0, `the site's request log could not be read: ${outcome.stderr}`);
  const text: unknown = JSON.parse(outcome.stdout.trim().split('\n').at(-1) ?? '""');
  assert.ok(typeof text === 'string');
  return text.split('\n').filter((line) => line !== '').map((line): SiteRequest => {
    const parsed: unknown = JSON.parse(line);
    assert.ok(typeof parsed === 'object' && parsed !== null);
    const server: unknown = Reflect.get(parsed, 'server');
    const path: unknown = Reflect.get(parsed, 'path');
    assert.ok((server === 'site' || server === 'second') && typeof path === 'string', line);
    return { server, path };
  });
}

// The real Docker runner, with the test set mounted so the site can be served inside, wrapped so
// the test sees what the draft command asks of it.
function watchedRunner(image: ImageDigest, watch: RunnerWatch): { readonly runner: Runner; readonly image: ImageDigest } {
  const inner = dockerRunner({ engine: dockerCliEngine(), repositoryRoot: REPOSITORY_ROOT, inputs: ['test', 'fixtures', 'golden'] });
  const runner: Runner = {
    guaranteeLevel: () => inner.guaranteeLevel(),
    async start(started, policy) {
      watch.policies.push(policy);
      const result = await inner.start(started, policy);
      if (!result.ok) return result;
      const handle = result.value;
      const site = await handle.exec(['node', '-e', startSiteScript]);
      if (site.exitCode !== 0) {
        await handle.stop();
        assert.fail(`the fixture site did not start inside the run container: ${site.stdout} ${site.stderr}`);
      }
      const watched: RunnerHandle = {
        runId: handle.runId,
        egressEvents: () => handle.egressEvents(),
        proxyDecisions: () => handle.proxyDecisions(),
        rewritesApplied: () => handle.rewritesApplied(),
        async exec(command, environmentNames = []) {
          const outcome = await handle.exec(command, environmentNames);
          watch.execs.push({ command, environmentNames, outcome });
          return outcome;
        },
        async stop() {
          try {
            watch.requests = parsedRequests(await handle.exec(['node', '-e', readRequestsScript]));
            watch.crawlEgress = handle.egressEvents();
            await handle.exec(['node', '-e', productionRequestScript]);
            watch.probeEgress = handle.egressEvents();
          } finally {
            await handle.stop();
          }
        },
      };
      return success(watched);
    },
  };
  return { runner, image };
}

// ---- One crawl in the container, captured --------------------------------------------------------------

type ContainerCrawl = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly errors: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly pageMap: string;
  readonly map: WrittenMap;
  // Everything the command left behind: its output, console, events, files and planner requests.
  readonly leftBehind: string;
  readonly hostSessions: number;
  readonly watch: RunnerWatch;
  readonly commandLines: readonly (readonly string[])[];
  readonly loginName: string;
  readonly leftContainers: readonly string[];
  readonly leftNetworks: readonly string[];
};

let image: ImageDigest;

async function crawlInContainer(extra: readonly string[], setup: Partial<ExploreSetup> = {}): Promise<ContainerCrawl> {
  const watch: RunnerWatch = { policies: [], execs: [], crawlEgress: [], probeEgress: [], requests: [] };
  const loginName = `Readername${letterNonce(20)}`;
  const secrets = exploreSecrets(loginName);
  // The Docker client copies each secret by name from its own environment, which is this process's.
  const previous = new Map([OFFICE_KEY_NAME, LOGIN_NAME_SECRET].map((name) => [name, process.env[name]] as const));
  for (const [name, value] of Object.entries(secrets)) process.env[name] = value;
  const siteRequested: string[] = [];
  const secondRequested: string[] = [];
  const insideSite = async (): Promise<ExploreSite> => ({
    origin: INSIDE_SITE_ORIGIN, secondOrigin: INSIDE_SECOND_ORIGIN, requested: siteRequested, secondRequested, close: async () => undefined,
  });
  const containersBefore = dockerIds('containers');
  const networksBefore = dockerIds('networks');
  const spy = spyOnDockerCommandLines();
  let captured: Omit<ContainerCrawl, 'commandLines' | 'leftContainers' | 'leftNetworks'> | undefined;
  try {
    await withExploreRun({
      ...setup,
      argv: () => exploreArguments(START, [...extra, '--json']),
      site: insideSite,
      isolatedRunner: () => watchedRunner(image, watch),
      secrets,
    }, (run) => {
      captured = {
        exitCode: run.outcome.exitCode,
        stdout: run.outcome.stdout,
        errors: exploreErrorCodes(run),
        data: exploreData(run),
        pageMap: pageMapText(run),
        map: writtenMap(run),
        leftBehind: everythingExplored(run),
        hostSessions: run.browser?.opened.length ?? 0,
        watch,
        loginName,
      };
    });
  } finally {
    spy.restore();
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
  assert.ok(captured !== undefined, 'the draft command was not run');
  return {
    ...captured, commandLines: spy.lines,
    leftContainers: newIds(containersBefore, dockerIds('containers')), leftNetworks: newIds(networksBefore, dockerIds('networks')),
  };
}

// Each crawl runs once; the tests read what it did.
let plainCrawl: Promise<ContainerCrawl> | undefined;
const crawled = async (): Promise<ContainerCrawl> => {
  plainCrawl ??= crawlInContainer([]);
  return plainCrawl;
};
let loginCrawl: Promise<ContainerCrawl> | undefined;
const crawledAfterLogin = async (): Promise<ContainerCrawl> => {
  loginCrawl ??= crawlInContainer(['--after', AFTER_PLAN_PATH], {
    files: { [AFTER_PLAN_PATH]: SIGN_IN_PLAN },
    approvals: async (project) => [await approvalOfPlan(SIGN_IN_PLAN, project)],
  });
  return loginCrawl;
};

before(async () => { image = await pinnedRunImage(); }, { timeout: TIMEOUT });

// The crawl's own exec in the run container: the cli's entry module, and nothing else.
const crawlExecs = (crawl: ContainerCrawl): RunnerWatch['execs'] => crawl.watch.execs.filter((exec) => exec.command.includes(CRAWL_MODULE));

function assertCrawled(crawl: ContainerCrawl): void {
  assert.deepEqual(crawl.errors, [], crawl.stdout);
  assert.equal(crawl.exitCode, 0, crawl.stdout);
  assert.equal(crawlExecs(crawl).length, 1, `the crawl did not run once in the container: ${JSON.stringify(crawl.watch.execs.map((exec) => exec.command))}`);
}

// ---- Isolation and the page map -------------------------------------------------------------------------

test('without --host, the crawl runs in the run container through the cli\'s entry module, and no host browser opens', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assertCrawled(crawl);
  const [exec] = crawlExecs(crawl);
  assert.equal(exec?.outcome.exitCode, 0, exec?.outcome.stderr);
  assert.equal(crawl.hostSessions, 0, 'a browser session was opened on this machine');
});

test('the page map says isolated and the --json output says egress was enforced', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assertCrawled(crawl);
  assert.equal(crawl.map.guaranteeLevel, 'isolated');
  assert.equal(crawl.data['egressEnforced'], true);
  assert.equal(crawl.data['crawledOrigin'], INSIDE_SITE_ORIGIN);
});

test('the run container\'s egress policy allows the start origin and nothing else', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assert.equal(crawl.watch.policies.length, 1);
  assert.deepEqual(crawl.watch.policies[0]?.allowOrigins, [INSIDE_SITE_ORIGIN]);
  assert.deepEqual(crawl.watch.policies[0]?.allowServices, []);
});

test('the run\'s containers and network are removed once the crawl ends', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assert.deepEqual(crawl.leftContainers, [], 'a container was left behind');
  assert.deepEqual(crawl.leftNetworks, [], 'a network was left behind');
});

test('the page map crawled in the container is the golden page map of the host-mode tests, apart from its origin and guarantee level', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assertCrawled(crawl);
  // The site is the same; only where it was served and how the crawl was placed differ.
  const normalised = crawl.pageMap.replaceAll(INSIDE_SITE_ORIGIN, SITE_PLACEHOLDER).replace('"guaranteeLevel":"isolated"', '"guaranteeLevel":"host"');
  assert.equal(normalised, GOLDEN_PAGE_MAP, JSON.stringify(crawlOrder(crawl.map)));
});

// ---- Other origins ----------------------------------------------------------------------------------------

test('the crawl never requests the second origin the home page links to', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assertCrawled(crawl);
  assert.deepEqual(crawl.watch.requests.filter((request) => request.server === 'second'), []);
  const paths = crawl.map.pages.map((page) => page.path);
  for (const foreign of ['/partner.html', '/checkout']) assert.equal(paths.includes(foreign), false, `${foreign} is in the page map`);
});

test('counter-example: the site\'s own server, inside the container, recorded the crawl\'s requests', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  const served = crawl.watch.requests.filter((request) => request.server === 'site').map((request) => request.path);
  assert.ok(served.includes('/index.html') && served.includes('/about.html'), JSON.stringify(crawl.watch.requests));
});

test('the proxy allowed no request to any origin but the start origin, and saw none for production or the second origin', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  assertCrawled(crawl);
  const events = crawl.watch.crawlEgress;
  assert.deepEqual(events.filter((event) => event.decision === 'allowed' && String(event.origin) !== INSIDE_SITE_ORIGIN), [], JSON.stringify(events));
  assert.deepEqual(events.filter((event) => hostOf(String(event.origin)) === PRODUCTION_HOST || String(event.origin) === INSIDE_SECOND_ORIGIN), [], JSON.stringify(events));
});

test('counter-example: a request through the same run\'s proxy for the production link\'s host is recorded, and blocked', { timeout: TIMEOUT }, async () => {
  const crawl = await crawled();
  const production = crawl.watch.probeEgress.filter((event) => hostOf(String(event.origin)) === PRODUCTION_HOST);
  assert.ok(production.length >= 1, `the proxy recorded nothing for ${PRODUCTION_HOST}: ${JSON.stringify(crawl.watch.probeEgress)}`);
  assert.ok(production.every((event) => event.decision === 'blocked'), JSON.stringify(production));
});

// ---- Logging in first, with a secret ---------------------------------------------------------------------

const secretValues = (crawl: ContainerCrawl): readonly string[] => [crawl.loginName, OFFICE_KEY_VALUE];

test('with an approved --after login plan, the container signs in before it crawls, and reaches the members\' page', { timeout: TIMEOUT }, async () => {
  const crawl = await crawledAfterLogin();
  assertCrawled(crawl);
  assert.ok(crawl.map.pages.some((page) => page.path === '/members.html'), JSON.stringify(crawlOrder(crawl.map)));
  const homeNames = allWrittenNodes(crawl.map.pages[0]?.tree ?? []).map((node) => node.name);
  assert.ok(homeNames.some((name) => name.startsWith('Signed in as ')), JSON.stringify(homeNames));
});

test('the typed secret\'s value is on no docker command line the runner issued', { timeout: TIMEOUT }, async () => {
  const crawl = await crawledAfterLogin();
  assertCrawled(crawl);
  for (const value of secretValues(crawl)) {
    const carrying = crawl.commandLines.filter((line) => line.some((word) => word.includes(value)));
    assert.deepEqual(carrying, [], 'a secret\'s value is on a docker command line');
  }
});

test('counter-example: the command-line spy sees the crawl\'s docker exec, its secret names and its start URL', { timeout: TIMEOUT }, async () => {
  const crawl = await crawledAfterLogin();
  const crawlLines = crawl.commandLines.filter((line) => line[1] === 'exec' && line.includes(CRAWL_MODULE));
  assert.equal(crawlLines.length, 1, JSON.stringify(crawl.commandLines.map((line) => line.slice(0, 4))));
  const line = crawlLines[0] ?? [];
  for (const name of [LOGIN_NAME_SECRET, OFFICE_KEY_NAME]) {
    assert.ok(line.some((word, index) => word === '--env' && line[index + 1] === name), `${name} is not passed by name: ${JSON.stringify(line)}`);
  }
  assert.ok(line.some((word) => word.includes(START)), 'the crawl\'s input is not on its command line');
});

test('the typed secret\'s value is in no page map, draft, output or event, nor in what the container printed or the proxy recorded', { timeout: TIMEOUT }, async () => {
  const crawl = await crawledAfterLogin();
  assertCrawled(crawl);
  const everything = [
    crawl.leftBehind,
    ...crawl.watch.execs.flatMap((exec) => [exec.outcome.stdout, exec.outcome.stderr]),
    JSON.stringify(crawl.watch.crawlEgress),
  ].join('\n');
  for (const value of secretValues(crawl)) assert.equal(everything.includes(value), false, 'a secret\'s value leaked');
});

test('counter-example: the signed-in pages did show the typed name, and the map holds its heading with the name redacted', { timeout: TIMEOUT }, async () => {
  const crawl = await crawledAfterLogin();
  // The container's own printed map is what the host decoded: it holds the heading the name was in.
  const printed = crawlExecs(crawl)[0]?.outcome.stdout ?? '';
  assert.ok(printed.includes('Signed in as '), printed.slice(0, 500));
  assert.ok(crawl.pageMap.includes('Signed in as '), crawl.pageMap.slice(0, 500));
});
