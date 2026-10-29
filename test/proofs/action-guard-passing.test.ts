// The engine hands the policy gate's runtime guard to the driver on every action. A run whose plan
// clicks, hovers, fills, selects, uploads, presses and answers a dialog reaches a recording driver
// with each of those steps, in order, and every act() call carries a guard function. Hover,
// select and upload now reach the driver instead of failing with unsupported-step.
// A mutant shows the check finds an act() call made without a guard.
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import {
  defaultRedactor, parseProject, planParser, run,
  type ActionGuard, type ActionStep, type BrowserDriver, type ElementProbe, type Session, type TargetId,
} from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';

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
  version: '1.1',
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

const SHOWN: ElementProbe = { count: 1, visible: true, enabled: true, text: 'Saved', value: null, sensitive: false, box: { x: 0, y: 0, width: 10, height: 10 } };

// A driver that needs no browser and records each act() call and the guard it was given.
function recordingDriver(): { readonly driver: BrowserDriver; readonly calls: ActCall[] } {
  const calls: ActCall[] = [];
  const session: Session = {
    browser: { name: 'recording-browser', version: '1.0' },
    navigate: async () => ({ ok: true, value: undefined }),
    page: async () => ({ url: `${ORIGIN}/drafts`, title: 'Drafts' }),
    act: async (step, guard) => { calls.push({ type: step.type, guard }); return { ok: true, value: undefined }; },
    probe: async () => SHOWN,
    screenshot: async () => new Uint8Array(),
    audit: async () => [],
    accessibilitySnapshot: async () => ({ role: 'document', name: '', children: [] }),
    blockedOrigins: () => [],
    close: async () => undefined,
  };
  const driver: BrowserDriver = {
    info: { id: 'cdp', version: 'recording', protocol: 'none' },
    supports: () => ({ ok: true, value: true }),
    open: async () => ({ ok: true, value: session }),
  };
  return { driver, calls };
}

// The act() calls that came without a guard function.
const callsWithoutGuard = (calls: readonly ActCall[]): ActCall[] => calls.filter((call) => typeof call.guard !== 'function');

test('every act() call of a run carries the runtime guard, for every kind of action step', { criterion: 'AC-SPEC-06-09' }, async () => {
  const parsedProject = parseProject(PROJECT_FILE);
  assert.ok(parsedProject.ok, JSON.stringify(parsedProject.ok ? null : parsedProject.error));
  const parsedPlan = planParser(parsedProject.value)(PLAN);
  assert.ok(parsedPlan.ok, JSON.stringify(parsedPlan.ok ? null : parsedPlan.error));
  const trusted = await trustedProjectFrom(PROJECT_FILE);
  const { driver, calls } = recordingDriver();
  const result = await run({
    project: parsedProject.value, plan: authorise(parsedPlan.value, trusted), targetId: TARGET_ID as TargetId, baseUrl: ORIGIN,
    seed: 7, fixedTimeMilliseconds: Date.UTC(2026, 9, 29, 9, 0, 0), fixtures: [], host: { platform: platform(), arch: arch() },
  }, {
    drivers: new Map([['cdp', driver]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(),
    audit: memoryEventSink(), events: memoryRunEventSink(),
  });
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps.filter((step) => step.outcome !== 'passed')));
  assert.deepEqual(calls.map((call) => call.type), ['click', 'hover', 'fill', 'select', 'upload', 'press', 'click', 'dialog']);
  assert.deepEqual(callsWithoutGuard(calls), []);
});

test('mutant: the check finds an act() call made without a guard', { criterion: 'AC-SPEC-06-09' }, () => {
  const guard: ActionGuard = () => ({ kind: 'allow' });
  const recorded: ActCall[] = [{ type: 'click', guard }, { type: 'hover', guard: undefined }, { type: 'dialog', guard }];
  assert.deepEqual(callsWithoutGuard(recorded).map((call) => call.type), ['hover']);
});
