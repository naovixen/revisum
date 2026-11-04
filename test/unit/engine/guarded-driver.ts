// A driver that needs no browser and honours the policy gate's runtime guard the way the real drivers must
// every real driver must: before each action it resolves the element, asks the guard it was given,
// and sends the input event only on an allow. Each acting step's input events are counted, so a
// test can show that a denied step sent none.
//
// Used to run plans through run() and runUntrusted() end to end. The real CDP
// driver does not wire the guard in yet, so it is not tested here.
//
// A dialog step acts on no element: the driver asks the guard with an element whose fields are all
// null, and passes the open dialog's text as the guard's second argument.
import { failure, planParser, runUntrusted, success, type BrowserDriver, type GuardVerdict, type Plan, type PlanError, type ResolvedElement, type Result, type RunInputs, type RunPorts, type RunResult } from '@revisum/engine';
import { arch, platform } from 'node:os';
import { ORIGIN, element, parserProject, policyProjectInput, type JsonRecord } from './policy-examples.ts';
import { fakeArtifactStore } from '#test-support/fakes/FakeArtifactStore.ts';
import { fakeClock } from '#test-support/fakes/FakeClock.ts';
import { fakeDriverOpening } from '#test-support/fakes/FakeDriver.ts';
import { driversOf } from '#test-support/fakes/FakePorts.ts';
import { fakeRedactor } from '#test-support/fakes/FakeRedactor.ts';
import { fakeRunEventSink } from '#test-support/fakes/FakeRunEventSink.ts';
import { performableAction } from '#test-support/fakes/FakePage.ts';
import { fakeSession } from '#test-support/fakes/FakeSession.ts';

// What the page shows for one step: the element its locator resolves to, or an open dialog's text.
export type PageView = { readonly element?: Partial<ResolvedElement>; readonly dialogText?: string };
export type PageViews = Readonly<Record<string, PageView>>;

// Steps that send input to the page, and so pass the guard first.
const ACTING_STEP_TYPES: readonly string[] = ['click', 'hover', 'fill', 'select', 'upload', 'press', 'download', 'dialog'];

export type GuardedDriver = {
  readonly driver: BrowserDriver;
  // How many sessions were opened: zero means the run never reached the browser.
  readonly opens: () => number;
  // Input events sent, per step index of the plan's steps.
  readonly inputEvents: readonly number[];
  // How many times a guard was asked.
  readonly guardCalls: () => number;
};

// The element a step's literal locator names, unless the page says otherwise.
function elementFor(step: JsonRecord, seen: PageView | undefined): ResolvedElement {
  if (seen?.element !== undefined) return element(seen.element);
  if (step['type'] === 'dialog') return element();
  const locator = step['locator'];
  if (typeof locator !== 'object' || locator === null) return element();
  const fields = locator as JsonRecord;
  if (fields['by'] === 'role') return element({ role: String(fields['role']), name: String(fields['name']) });
  if (fields['by'] === 'label') return element({ role: 'textbox', name: String(fields['label']) });
  if (fields['by'] === 'text') return element({ name: String(fields['text']) });
  return element();
}

// `steps` are the plan's raw steps, in order, and `page` what each acting step finds, by step index.
// The n-th action the run asks for is the plan's n-th acting step.
export function guardedDriver(steps: readonly JsonRecord[], page: PageViews = {}, adapterId = 'cdp'): GuardedDriver {
  const actingIndexes = steps.flatMap((step, index) => (ACTING_STEP_TYPES.includes(String(step['type'])) ? [index] : []));
  const inputEvents = steps.map(() => 0);

  let actions = 0;
  let guardCalls = 0;
  const session = fakeSession({
    browser: { name: 'guarded-browser', version: '1.0' },
    page: () => Promise.resolve({ url: `${ORIGIN}/`, title: 'Account', meta: [], canonicalUrl: null }),
    act: (step, guard, secret) => {
      const index = actingIndexes[actions] ?? -1;
      actions++;
      // What any driver refuses comes before the guard and the page.
      if (step.type !== 'dialog') {
        const performable = performableAction(step, secret);
        if (!performable.ok) {
          return Promise.resolve(performable);
        }
      }
      const raw = steps[index] ?? {};
      const seen = page[String(index)];
      const kind: string = step.type;
      guardCalls++;
      // A guard may read the open dialog's text as a second argument; one that does not ignores it.
      const ask: (resolved: ResolvedElement, dialogText: string | null) => GuardVerdict = guard;
      const verdict = ask(elementFor(raw, seen), kind === 'dialog' ? (seen?.dialogText ?? null) : null);
      if (verdict.kind === 'deny') return Promise.resolve(failure({ code: 'policy-denied', detail: verdict.rule }));
      if (index >= 0) inputEvents[index] = (inputEvents[index] ?? 0) + 1;
      return Promise.resolve(success(undefined));
    },
  });
  const driver = fakeDriverOpening(session, { info: { id: adapterId, version: 'guarded', protocol: 'none' } });
  return { driver, opens: () => driver.calls.count('open'), inputEvents, guardCalls: () => guardCalls };
}

// What a run needs besides the plan and target, for the policy test project.
export const runBase = (projectInput: JsonRecord = policyProjectInput()): Omit<RunInputs, 'plan' | 'targetId'> => ({
  project: parserProject(projectInput), baseUrl: ORIGIN, seed: 7, fixedTimeMilliseconds: Date.UTC(2026, 9, 28, 12, 0, 0),
  fixtures: [], host: { platform: platform(), arch: arch() },
});

// The ports of a run on `driver`, without an audit sink; tests add one where they need it.
export const portsWithoutAudit = (driver: BrowserDriver): Omit<RunPorts, 'audit'> => ({
  drivers: driversOf(driver), clock: fakeClock(), artifacts: fakeArtifactStore(),
  redactor: fakeRedactor(), events: fakeRunEventSink(),
});

export const parserFor = (projectInput: JsonRecord = policyProjectInput()) =>
  (input: unknown): Result<Plan, readonly PlanError[]> => planParser(parserProject(projectInput))(input);

export type UntrustedOutcome = Awaited<ReturnType<typeof runUntrusted>>;

// The state a runUntrusted outcome ended in: Rejected or Denied before any run, or the one run's state.
export function finalState(outcome: UntrustedOutcome): string {
  if (!Array.isArray(outcome)) return (outcome as { readonly state: string }).state;
  const runs: readonly RunResult[] = outcome;
  if (runs.length !== 1) throw new Error(`expected one run, got ${runs.length}`);
  return runs[0]?.state ?? 'none';
}

// The one run's result, when the plan ran at all.
export const onlyRun = (outcome: UntrustedOutcome): RunResult | undefined => (Array.isArray(outcome) ? (outcome as readonly RunResult[])[0] : undefined);
