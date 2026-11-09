// The engine hands the policy gate's runtime guard to the driver on every action. A run whose plan
// clicks, hovers, fills, selects, uploads, presses and answers a dialog reaches a recording driver
// with each of those steps, in order, and every act() call carries a guard function. Hover,
// select and upload now reach the driver instead of failing with unsupported-step.
// A mutant shows the check finds an act() call made without a guard.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { createRunService, parseProject, planParser, success, type ActionGuard, type ActionStep, type BrowserDriver, type ElementProbe, type TargetId } from '@revisum/engine';
import { baseUrlOf, clearRun, trustedProjectFrom } from '../../support/builders/ClearRun.ts';
import { fakeDriverOpening } from '#test-support/fakes/session/FakeDriver.ts';
import { FAKE_ELEMENT } from '#test-support/fakes/session/FakePage.ts';
import { driversOf, fakePorts } from '#test-support/fakes/FakePorts.ts';
import { fakeSession } from '#test-support/fakes/session/FakeSession.ts';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_ID = 'cdp-chromium';
const UPLOAD_FIXTURE = 'upload-note.txt';

const PROJECT_FILE = {
  origins: [ORIGIN],
  limits: { stepTimeoutMilliseconds: 2000 },
  fixtures: [UPLOAD_FIXTURE],
  matrix: [{
    id: TARGET_ID, adapter: 'cdp', engine: 'chromium', device: 'desktop-1280',
    locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
  }],
};

const label = (text: string) => ({ by: 'label', label: text });
const role = (roleName: string, name: string) => ({ by: 'role', role: roleName, name });

const PLAN = {
  version: '1.3',
  meta: { featureId: 'DRAFTS-1', specReference: 'specs/drafts.md#save', title: 'Save a draft' },
  targets: [TARGET_ID],
  steps: [
    { type: 'navigate', url: '/drafts' },
    { type: 'click', locator: role('button', 'New draft') },
    { type: 'hover', locator: role('button', 'Help') },
    { type: 'fill', locator: label('Note'), value: 'Remember the milk' },
    { type: 'select', locator: label('Size'), option: 'Large' },
    { type: 'upload', locator: label('Attachment'), fixture: UPLOAD_FIXTURE },
    { type: 'press', locator: label('Note'), key: 'Enter' },
    { type: 'click', locator: role('button', 'Ask a question') },
    { type: 'dialog', action: 'accept', expectText: 'Keep the draft?' },
    { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'drafts.status-shown' },
  ],
};

type ActCall = { readonly type: ActionStep['type']; readonly guard: ActionGuard | undefined };

const SHOWN: ElementProbe = { ...FAKE_ELEMENT, text: 'Saved', box: { x: 0, y: 0, width: 10, height: 10 } };

// A driver that needs no browser and records each act() call and the guard it was given.
function recordingDriver(): { readonly driver: BrowserDriver; readonly calls: ActCall[] } {
  const calls: ActCall[] = [];
  const session = fakeSession({
    browser: { name: 'recording-browser', version: '1.0' },
    page: () => Promise.resolve(success({ url: `${ORIGIN}/drafts`, title: 'Drafts', meta: [], canonicalUrl: null })),
    act: (step, guard) => { calls.push({ type: step.type, guard }); return Promise.resolve(success(undefined)); },
    probe: () => Promise.resolve(SHOWN),
    screenshot: () => Promise.resolve(success(new Uint8Array())),
  });
  const driver = fakeDriverOpening(session, { info: { id: 'cdp', version: 'recording', protocol: 'none' } });
  return { driver, calls };
}

// The act() calls that came without a guard function.
const callsWithoutGuard = (calls: readonly ActCall[]): ActCall[] => calls.filter((call) => typeof call.guard !== 'function');

test('every act() call of a run carries the runtime guard, for every kind of action step', async () => {
  const parsedProject = parseProject(PROJECT_FILE);
  assert.ok(parsedProject.ok, JSON.stringify(parsedProject.ok ? null : parsedProject.error));
  const parsedPlan = planParser(parsedProject.value)(PLAN);
  assert.ok(parsedPlan.ok, JSON.stringify(parsedPlan.ok ? null : parsedPlan.error));
  const trusted = await trustedProjectFrom(PROJECT_FILE);
  const { driver, calls } = recordingDriver();
  const result = await createRunService(fakePorts({ drivers: driversOf(driver) })).run(clearRun(parsedPlan.value, trusted, TARGET_ID as TargetId), { baseUrl: baseUrlOf(ORIGIN),
    seed: 7, fixedTimeMilliseconds: Date.UTC(2026, 9, 29, 9, 0, 0), fixtures: [], host: { platform: platform(), arch: arch() },
  });
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps.filter((step) => step.outcome !== 'passed')));
  assert.deepEqual(calls.map((call) => call.type), ['click', 'hover', 'fill', 'select', 'upload', 'press', 'click', 'dialog']);
  assert.deepEqual(callsWithoutGuard(calls), []);
});

test('mutant: the check finds an act() call made without a guard', () => {
  const guard: ActionGuard = () => ({ kind: 'allow' });
  const recorded: ActCall[] = [{ type: 'click', guard }, { type: 'hover', guard: undefined }, { type: 'dialog', guard }];
  assert.deepEqual(callsWithoutGuard(recorded).map((call) => call.type), ['hover']);
});
