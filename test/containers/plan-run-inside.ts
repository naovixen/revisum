// Runs inside the run container, started through RunnerHandle.exec by egress-enforcement.test.ts;
// it is not a test file of its own. It serves the egress fixture app on the container's own
// loopback, runs one plan on the CDP driver with the run's egress proxy (from HTTP_PROXY) for
// everything that is not loopback, and prints the run's state as JSON on its last line.
// The plan opens a page whose WebSocket goes to an undeclared origin and passes only once the
// page shows that WebSocket was closed.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { arch, platform } from 'node:os';
import { cdpDriver } from '@revisum/driver-cdp';
import { defaultRedactor, parseProject, planParser, run, type BrowserDriver, type TargetId } from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { startEgressFixtureServer } from '../unit/runner/egress-fixture-server.ts';

const TARGET_ID = 'cdp-chromium';
const SEED = 7;
const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 9, 29, 12, 0, 0);

async function main(): Promise<number> {
  const proxyServer = process.env['HTTP_PROXY'];
  if (proxyServer === undefined || proxyServer === '') {
    console.log(JSON.stringify({ problem: 'HTTP_PROXY is not set inside the run container' }));
    return 2;
  }
  const fixture = await startEgressFixtureServer();
  try {
    const projectFile = {
      origins: [fixture.origin],
      limits: { stepTimeoutMilliseconds: 10_000 },
      matrix: [{
        id: TARGET_ID, adapter: 'cdp', engine: 'chromium', device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London',
        colorScheme: 'light', reducedMotion: 'reduce',
      }],
    };
    const project = parseProject(projectFile);
    if (!project.ok) throw new Error(`bad project: ${JSON.stringify(project.error)}`);
    const parsed = planParser(project.value)({
      version: '1.1',
      meta: { featureId: 'ISOLATION-1', specReference: 'specs/isolation.md#egress', title: 'An undeclared WebSocket is blocked' },
      targets: [TARGET_ID],
      steps: [
        { type: 'navigate', url: '/leak.html' },
        { type: 'expect', locator: { by: 'role', role: 'heading', name: 'Leak fixture' }, assert: { kind: 'visible' }, criterionId: 'isolation.page-shown' },
        { type: 'expect', locator: { by: 'testId', testId: 'socket-state' }, assert: { kind: 'textEquals', value: 'closed' }, criterionId: 'isolation.socket-refused' },
      ],
    });
    if (!parsed.ok) throw new Error(`plan rejected: ${JSON.stringify(parsed.error)}`);
    const trusted = await trustedProjectFrom(projectFile);
    // The fixture app is on the container's own loopback, which the proxy, in another container,
    // cannot reach; everything else goes through the proxy.
    const drivers = new Map<string, BrowserDriver>([
      ['cdp', cdpDriver({ executablePath: BROWSERS.chrome, proxy: { server: proxyServer, includeLoopback: false } })],
    ]);
    // The target id comes from the project written just above, so it is used as the branded value directly.
    const result = await run({
      project: project.value, baseUrl: fixture.origin, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, fixtures: fixture.fixtures,
      host: { platform: platform(), arch: arch() }, plan: authorise(parsed.value, trusted), targetId: TARGET_ID as TargetId,
    }, {
      drivers, clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
    });
    console.log(JSON.stringify({ state: result.state }));
    return 0;
  } finally {
    await fixture.close();
  }
}

if (import.meta.main) process.exitCode = await main();
