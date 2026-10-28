// Shared setup for the driver contract and the run guarantees: the trusted project, the driver
// registry, the sign-up fixture app and the plans, written as raw JSON the way a person or an AI
// planner would write them.
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { cdpDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  defaultRedactor, parseProject, planParser, run,
  type BrowserDriver, type Plan, type Project, type RunEventSink, type RunInputs, type RunResult, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from './browsers.ts';
import { startFixtureServer, type FixtureServer } from './fixture-server.ts';
import { memoryArtifactStore, memoryRunEventSink, systemClock, type MemoryArtifactStore } from './memory-ports.ts';
import { FIXTURES } from './repository.ts';

export const SEED = 42;
export const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 0, 15, 10, 30, 0);
export const LOCALE = 'de-DE';
export const TIMEZONE = 'Asia/Tokyo';

// Every driver must pass the contract unchanged on each of these targets.
export const CONTRACT_TARGETS = ['playwright-chromium', 'playwright-firefox', 'playwright-webkit', 'cdp-chromium'] as const;

const desktop = { device: 'desktop-1280', locale: LOCALE, timezone: TIMEZONE, colorScheme: 'dark', reducedMotion: 'reduce' } as const;

export function makeProject(origin: string): Project {
  const parsed = parseProject({
    origins: [origin],
    limits: { stepTimeoutMilliseconds: 2000 },
    matrix: [
      { id: 'playwright-chromium', adapter: 'playwright', engine: 'chromium', ...desktop },
      { id: 'playwright-firefox', adapter: 'playwright', engine: 'firefox', ...desktop },
      { id: 'playwright-webkit', adapter: 'playwright', engine: 'webkit', ...desktop },
      { id: 'cdp-chromium', adapter: 'cdp', engine: 'chromium', ...desktop },
      // Targets no registered driver can serve, to prove they are reported and never substituted.
      { id: 'playwright-firefox-phone', adapter: 'playwright', engine: 'firefox', ...desktop, device: 'phone-390' },
      { id: 'appium-android', adapter: 'appium', engine: 'chromium', ...desktop, device: 'phone-390' },
    ],
  });
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const makeDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['playwright', playwrightDriver()],
  ['cdp', cdpDriver({ executablePath: BROWSERS.chrome })],
]);

export type Ran = { readonly result: RunResult; readonly events: RunEventSink; readonly store: MemoryArtifactStore };

export type Harness = {
  readonly server: FixtureServer;
  readonly project: Project;
  readonly parse: (input: unknown) => ReturnType<ReturnType<typeof planParser>>;
  plan(raw: unknown): Plan;
  base(): Omit<RunInputs, 'plan' | 'targetId'>;
  run(plan: Plan, targetId: string, drivers?: ReadonlyMap<string, BrowserDriver>): Promise<Ran>;
  close(): Promise<void>;
};

export async function harness(): Promise<Harness> {
  const server = await startFixtureServer(join(FIXTURES, 'signup-app'));
  const project = makeProject(server.origin);
  const parse = planParser(project);
  const drivers = makeDrivers();
  const base = (): Omit<RunInputs, 'plan' | 'targetId'> => ({
    project, baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, fixtures: server.fixtures,
    host: { platform: platform(), arch: arch() },
  });
  return {
    server, project, parse, base,
    plan(raw) {
      const parsed = parse(raw);
      if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
      return parsed.value;
    },
    async run(plan, targetId, chosenDrivers = drivers) {
      const events = memoryRunEventSink();
      const store = memoryArtifactStore();
      // The target id comes from the trusted test project, so it is used as the branded value directly.
      const result = await run({ ...base(), plan, targetId: targetId as TargetId }, {
        drivers: chosenDrivers, clock: systemClock, artifacts: store, redactor: defaultRedactor(), events,
      });
      return { result, events, store };
    },
    close: () => server.close(),
  };
}

// ---- Plans ------------------------------------------------------------------------------------

const meta = (title: string) => ({ featureId: 'SIGNUP-1', specReference: 'specs/signup.md#happy-path', title });
const role = (roleName: string, name: string) => ({ by: 'role', role: roleName, name });
const label = (labelText: string) => ({ by: 'label', label: labelText });
const testId = (id: string) => ({ by: 'testId', testId: id });

export const NAME = 'Ada Lovelace';
export const EMAIL = 'ada@example.test';

// Plans are written in version "1.1" of the plan language: every assertion carries the id of the
// acceptance criterion it checks, and a plan with no assertion is rejected as vacuous.
export const PLAN_LANGUAGE_VERSION = '1.1';

export const signupPlan = (targets: readonly string[]) => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: meta('Sign-up happy path'),
  targets,
  steps: [
    { type: 'navigate', url: '/' },
    { type: 'expect', locator: role('heading', 'Create your account'), assert: { kind: 'visible' }, criterionId: 'signup.heading-shown' },
    { type: 'expectPage', assert: { kind: 'title', value: 'Sign up - Fixture' }, criterionId: 'signup.page-titled' },
    { type: 'fill', locator: label('Full name'), value: NAME },
    { type: 'fill', locator: label('Email'), value: EMAIL },
    { type: 'expect', locator: label('Email'), assert: { kind: 'valueEquals', value: EMAIL }, criterionId: 'signup.email-kept' },
    { type: 'capture', name: 'form-filled' },
    { type: 'click', locator: role('checkbox', 'I agree to the terms') },
    { type: 'click', locator: role('button', 'Create account') },
    { type: 'expect', locator: testId('status'), assert: { kind: 'textContains', value: 'Welcome' }, criterionId: 'signup.welcome-shown' },
    { type: 'expect', locator: testId('echo'), assert: { kind: 'textContains', value: 'Signed up as' }, criterionId: 'signup.address-echoed' },
    { type: 'a11yAudit', mode: 'report' },
    { type: 'capture', name: 'signed-up' },
  ],
});

export const environmentPlan = (targets: readonly string[], expected: Readonly<Record<string, string>>) => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: meta('Determinism controls are applied'),
  targets,
  steps: [
    { type: 'navigate', url: '/' },
    ...Object.entries(expected).map(([id, value]) => ({ type: 'expect', locator: testId(id), assert: { kind: 'textEquals', value }, criterionId: `environment.${id}-pinned` })),
  ],
});

const ASSERTION_TYPES: readonly unknown[] = ['expect', 'expectPage'];
const isAssertion = (step: unknown): step is Record<string, unknown> =>
  typeof step === 'object' && step !== null && ASSERTION_TYPES.includes((step as Record<string, unknown>)['type']);

// A probe plan: navigate, then the given steps. Each given assertion without a criterion id gets
// one. A plan must assert something, so when the given steps hold no assertion, a check that the
// sign-up form is shown is added last; it passes on the fixture app's first page.
export const stepsPlan = (targets: readonly string[], steps: readonly unknown[]) => ({
  version: PLAN_LANGUAGE_VERSION, meta: meta('Contract probe'), targets, steps: [
    { type: 'navigate', url: '/' },
    ...steps.map((step, index) => (isAssertion(step) && !('criterionId' in step) ? { ...step, criterionId: `probe.assertion-${index + 1}` } : step)),
    ...(steps.some(isAssertion) ? [] : [
      { type: 'expect', locator: role('heading', 'Create your account'), assert: { kind: 'visible' }, criterionId: 'probe.form-shown' },
    ]),
  ],
});
