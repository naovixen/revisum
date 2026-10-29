// The browser processes of the own CDP driver, on Chrome for Testing and on its headless shell:
//   - the headless-shell target really launches the chrome-headless-shell build;
//   - a tab that crashes mid-plan fails the step that was running with target-crashed, the rest is
//     skipped, and the session still closes cleanly;
//   - when close() returns, every process the driver started has exited: after a direct session,
//     after a run, after a crash and with a dialog left open.
// A crash is made the way it happens: the tab's renderer process ends at once. Each check that a
// process has exited is shown able to fail by the same check run before close().
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, CDP_TARGETS, HEADLESS_SHELL_TARGET, capabilityDrivers, capabilityHarness, capabilityPlan, click, navigate, ownDriverFor,
  role, testId, textEquals, watchedDriver, type CapabilityHarness,
} from '../support/capability-harness.ts';
import { endAtOnce, listProcesses, processTree, rendererProcesses, stillRunning } from '../support/process-tree.ts';
import { CRASH_READY_PATH, crashWhenRequested } from '../support/tab-crash.ts';

// Long enough for the test to find and end the renderer while the step waits.
const CRASH_STEP_TIMEOUT_MILLISECONDS = 8000;
const ADAPTERS: Readonly<Record<string, string>> = { [CDP_TARGET]: 'cdp', [HEADLESS_SHELL_TARGET]: 'cdp-headless-shell' };

let capability: CapabilityHarness;
before(async () => { capability = await capabilityHarness(CRASH_STEP_TIMEOUT_MILLISECONDS); });
after(async () => { await capability.close(); });

// The executable file name of a process, from its command line.
const executableName = (commandLine: string): string => basename(commandLine.replace(/^"([^"]+)".*$/, '$1').split(/\s+--/)[0] ?? '');

describe('the headless shell target', () => {
  test('runs the chrome-headless-shell build, and the Chrome for Testing target does not', { criterion: 'AC-SPEC-06-01' }, async () => {
    const names: Record<string, string> = {};
    for (const targetId of CDP_TARGETS) {
      const session = await capability.openOwn(targetId);
      try {
        const browser = listProcesses().find((candidate) => candidate.processId === session.processId);
        assert.ok(browser, `${targetId}: the browser process is running`);
        names[targetId] = executableName(browser.commandLine);
      } finally {
        await session.close();
      }
    }
    assert.match(names[HEADLESS_SHELL_TARGET] ?? '', /^chrome-headless-shell(\.exe)?$/);
    assert.match(names[CDP_TARGET] ?? '', /^chrome(\.exe)?$/);
  });
});

for (const targetId of CDP_TARGETS) {
  describe(`a crashed tab: ${targetId}`, () => {
    const crashedRun = async (steps: readonly unknown[]) => {
      const watched = watchedDriver(ownDriverFor(targetId));
      const drivers = new Map([...capabilityDrivers(), [ADAPTERS[targetId] ?? '', watched.driver]]);
      const crashed = crashWhenRequested(capability, watched, CRASH_READY_PATH);
      const ran = await capability.run(capability.plan(capabilityPlan(targetId, steps)), targetId, drivers);
      return { ...ran, endedRenderers: await crashed, watched };
    };

    test('a crash while a click waits fails that step with target-crashed and skips the rest', { criterion: 'AC-SPEC-06-04' }, async () => {
      const { result, endedRenderers } = await crashedRun([
        navigate('/crash.html'),
        click(role('button', 'Start the report')),
        textEquals(testId('crash-status'), 'Waiting', 'crash.never-reached'),
      ]);
      assert.ok(endedRenderers > 0, 'the test found a renderer to end');
      assert.equal(result.state, 'Failed');
      assert.deepEqual(result.steps.map((step) => [step.outcome, step.code]), [['passed', undefined], ['failed', 'target-crashed'], ['skipped', undefined]]);
    });

    test('a crash while a check waits fails that check with target-crashed', { criterion: 'AC-SPEC-06-04' }, async () => {
      const { result, endedRenderers } = await crashedRun([
        navigate('/crash.html'),
        textEquals(testId('crash-status'), 'Report ready', 'crash.report-ready'),
        click(role('button', 'Start the report')),
      ]);
      assert.ok(endedRenderers > 0, 'the test found a renderer to end');
      assert.equal(result.state, 'Failed');
      assert.deepEqual(result.steps.map((step) => [step.outcome, step.code]), [['passed', undefined], ['failed', 'target-crashed'], ['skipped', undefined]]);
    });

    test('after a crash the run closes the session once, close() succeeds and every browser process exits', { criterion: 'AC-SPEC-06-04' }, async () => {
      const { watched } = await crashedRun([
        navigate('/crash.html'),
        click(role('button', 'Start the report')),
        textEquals(testId('crash-status'), 'Waiting', 'crash.never-reached'),
      ]);
      const session = watched.sessions[0];
      assert.ok(session !== undefined);
      assert.equal(session.closeCalls, 1);
      assert.equal(session.closeError, null);
      assert.ok(session.processesBeforeClose.length > 0, 'the browser was still running when close() was called');
      assert.deepEqual(session.stillRunningAfterClose, []);
    });

    test('an action on a crashed tab returns target-crashed, and close() still ends every process', { criterion: 'AC-SPEC-06-04' }, async () => {
      const session = await capability.openOwn(targetId);
      let tree: ReturnType<typeof processTree> = [];
      try {
        assert.ok((await session.navigate(capability.url('/dialog.html'))).ok);
        tree = processTree(session.processId);
        const renderers = rendererProcesses(session.processId);
        assert.ok(renderers.length > 0, 'the page has a renderer');
        for (const renderer of renderers) endAtOnce(renderer.processId);
        const acted = await session.act(capability.actionStep(click(role('button', 'Ask a question'))));
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'target-crashed');
      } finally {
        await session.close();
      }
      assert.deepEqual(stillRunning(tree), []);
    });

    test('counter-example: the same click with no crash fails with not-actionable, not target-crashed', { criterion: 'AC-SPEC-06-04' }, async () => {
      const quick = await capabilityHarness(500);
      try {
        const plan = quick.plan(capabilityPlan(targetId, [
          navigate('/crash.html'),
          click(role('button', 'Start the report')),
          textEquals(testId('crash-status'), 'Waiting', 'crash.never-reached'),
        ]));
        const { result } = await quick.run(plan, targetId);
        assert.equal(result.steps[1]?.code, 'not-actionable');
      } finally {
        await quick.close();
      }
    });
  });

  describe(`close() ends every process: ${targetId}`, () => {
    test('after a direct session with a loaded page, no process of the browser is still running', { criterion: 'AC-SPEC-06-07' }, async () => {
      const session = await capability.openOwn(targetId);
      let tree: ReturnType<typeof processTree> = [];
      try {
        assert.ok((await session.navigate(capability.url('/dialog.html'))).ok);
        tree = processTree(session.processId);
        assert.ok(tree.some((member) => member.processId === session.processId), 'the browser process is in the tree');
        assert.ok(tree.length >= 2, 'the browser started at least one other process');
        // Mutant: the same check before close() finds every process still running.
        assert.equal(stillRunning(tree).length, tree.length);
      } finally {
        await session.close();
      }
      assert.deepEqual(stillRunning(tree), []);
    });

    test('after a run, every process the driver started has exited when close() returns', { criterion: 'AC-SPEC-06-07' }, async () => {
      const watched = watchedDriver(ownDriverFor(targetId));
      const drivers = new Map([...capabilityDrivers(), [ADAPTERS[targetId] ?? '', watched.driver]]);
      const plan = capability.plan(capabilityPlan(targetId, [
        navigate('/dialog.html'),
        textEquals(testId('dialog-status'), 'Waiting', 'dialog.waiting'),
      ]));
      const { result } = await capability.run(plan, targetId, drivers);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      const session = watched.sessions[0];
      assert.ok(session !== undefined && session.closeCalls === 1);
      assert.ok(session.processesBeforeClose.length >= 2, 'the browser and its other processes were seen before close()');
      assert.deepEqual(session.stillRunningAfterClose, []);
    });

    test('with a dialog left open, close() still ends every process', { criterion: 'AC-SPEC-06-07' }, async () => {
      const session = await capability.openOwn(targetId);
      let tree: ReturnType<typeof processTree> = [];
      try {
        assert.ok((await session.navigate(capability.url('/dialog.html'))).ok);
        // The click opens a confirm dialog that nothing answers.
        assert.ok((await session.act(capability.actionStep(click(role('button', 'Ask a question'))))).ok);
        tree = processTree(session.processId);
      } finally {
        await session.close();
      }
      assert.ok(tree.length >= 2);
      assert.deepEqual(stillRunning(tree), []);
    });
  });
}
