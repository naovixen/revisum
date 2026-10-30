// Downloads in a real browser, on the own CDP driver. The fixture page
// (fixtures/page-states-app/downloads.html) links to files the test's server sends as
// attachments (see page-states-support.ts): a CSV, an empty CSV, a CSV four times the project's
// 64 KiB download limit streamed with no Content-Length, and a PNG.
// A download step's click must start exactly one download; each expectDownload check then passes
// or fails on the file as specified. A file over the limit fails with download-too-large and
// none of its bytes stay on disk; a click that starts no download fails with no-download; a
// content check of a file that is not text fails with download-not-text.
// A download started by any other step, even in a plan that has download steps, still fails
// with unsupported-step and leaves no file; so does a download step whose click opens a popup.
// A download step on a control named "Delete account" is denied by the runtime guard: the run
// ends Denied, no input event reaches the page and the file is never requested.
// Every file the server sends holds a marker; the disk is searched for it just before the run
// closes its session, while the driver's own download folder still exists.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Session } from '@revisum/engine';
import { filesHolding } from '../support/stored-files.ts';
import {
  CDP_TARGET, click, download, expectDownload, navigate, outcomes, pageStatesHarness, role, testId, textEquals,
  type JsonRecord, type PageStatesHarness,
} from './page-states-support.ts';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

const OPEN_DOWNLOADS = navigate('/downloads.html');
const STILL_READY = textEquals(testId('download-status'), 'Ready', 'downloads.page-ready');
const EXPORT_CSV = role('link', 'Export CSV');
const NAME = 'project-list';
const check = (assertion: JsonRecord): JsonRecord => expectDownload(NAME, assertion, 'downloads.checked');

// The files found on disk holding a marker as the session closed; null until it closed.
type DiskWatch = { found: readonly string[] | null; readonly beforeClose: (session: Session, startedAt: number) => Promise<void> };

// Searches the disk for files holding `marker` as the session closes, and keeps what it found.
function storedAtClose(marker: string): DiskWatch {
  const watch: DiskWatch = {
    found: null,
    beforeClose: async (_session, startedAt) => { watch.found = filesHolding(marker, startedAt); },
  };
  return watch;
}

describe('expectDownload checks on a CSV', () => {
  test('every check passes on the CSV it describes, at its exact size', { criterion: 'AC-SPEC-31-06' }, async () => {
    const csv = harness.files.projects;
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS,
      download(NAME, EXPORT_CSV),
      check({ kind: 'fileNameEquals', value: 'projects.csv' }),
      check({ kind: 'mediaTypeEquals', value: 'text/csv' }),
      check({ kind: 'sizeAtLeast', value: csv.bytes.length }),
      check({ kind: 'sizeAtMost', value: csv.bytes.length }),
      check({ kind: 'contentContains', value: 'Website relaunch' }),
      check({ kind: 'contentExcludes', value: 'Archived pilot' }),
      STILL_READY,
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.equal(requestedPaths.filter((path) => path === csv.path).length, 1, 'the CSV was fetched once');
  });

  const FAILING: readonly { readonly name: string; readonly assertion: () => JsonRecord }[] = [
    { name: 'fileNameEquals with another name', assertion: () => ({ kind: 'fileNameEquals', value: 'invoices.csv' }) },
    { name: 'mediaTypeEquals with another media type', assertion: () => ({ kind: 'mediaTypeEquals', value: 'application/json' }) },
    { name: 'sizeAtLeast one byte over the size', assertion: () => ({ kind: 'sizeAtLeast', value: harness.files.projects.bytes.length + 1 }) },
    { name: 'sizeAtMost one byte under the size', assertion: () => ({ kind: 'sizeAtMost', value: harness.files.projects.bytes.length - 1 }) },
    { name: 'contentContains with text the file does not hold', assertion: () => ({ kind: 'contentContains', value: 'Archived pilot' }) },
    { name: 'contentExcludes with text the file holds', assertion: () => ({ kind: 'contentExcludes', value: 'Website relaunch' }) },
  ];

  for (const failing of FAILING) {
    test(`${failing.name} fails with assertion-failed and skips the rest`, { criterion: 'AC-SPEC-31-06' }, async () => {
      const { result } = await harness.runSteps(CDP_TARGET, [OPEN_DOWNLOADS, download(NAME, EXPORT_CSV), check(failing.assertion()), STILL_READY]);
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'assertion-failed'], [3, 'skipped', undefined]]);
    });
  }
});

describe('an empty download', () => {
  // An empty file proves nothing about what it excludes.
  test('contentExcludes fails with assertion-failed on an empty file', { criterion: 'AC-SPEC-31-06' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, role('link', 'Export empty list')),
      check({ kind: 'mediaTypeEquals', value: 'text/csv' }), check({ kind: 'contentExcludes', value: 'Website relaunch' }), STILL_READY,
    ]);
    assert.deepEqual(outcomes(result), [
      [0, 'passed', undefined], [1, 'passed', undefined], [2, 'passed', undefined], [3, 'failed', 'assertion-failed'], [4, 'skipped', undefined],
    ]);
  });

  test('sizeAtLeast 1 fails with assertion-failed on an empty file', { criterion: 'AC-SPEC-31-06' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [OPEN_DOWNLOADS, download(NAME, role('link', 'Export empty list')), check({ kind: 'sizeAtLeast', value: 1 })]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'assertion-failed']]);
  });
});

describe('a download over the project\'s limit', () => {
  test('fails with download-too-large, skips its checks and leaves none of its bytes on disk', { criterion: 'AC-SPEC-31-06' }, async () => {
    const watch = storedAtClose(harness.files.oversize.marker);
    const ran = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, role('link', 'Export full history')), check({ kind: 'sizeAtLeast', value: 1 }), STILL_READY,
    ], { beforeClose: watch.beforeClose });
    assert.equal(ran.result.state, 'Failed');
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'download-too-large'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
    assert.deepEqual(watch.found, [], 'no partial bytes were left while the session was open');
    assert.deepEqual(filesHolding(harness.files.oversize.marker, ran.startedAt), [], 'no partial bytes were left after the run');
  });

  // Counter-example: a file within the limit is kept on disk while the session is open, where
  // the search above looks, so finding nothing there means something.
  test('counter-example: a CSV within the limit is stored on disk until the run closes', { criterion: 'AC-SPEC-31-06' }, async () => {
    const watch = storedAtClose(harness.files.projects.marker);
    const ran = await harness.runSteps(CDP_TARGET, [OPEN_DOWNLOADS, download(NAME, EXPORT_CSV), check({ kind: 'sizeAtLeast', value: 1 })], { beforeClose: watch.beforeClose });
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.equal(watch.found?.length, 1, `the CSV is stored once while the session is open: ${JSON.stringify(watch.found)}`);
    assert.deepEqual(filesHolding(harness.files.projects.marker, ran.startedAt), [], 'the run removed it when it closed');
  });
});

describe('a download step whose click starts no download', () => {
  test('fails with no-download after the click reached the page, and skips its checks', { criterion: 'AC-SPEC-31-06' }, async () => {
    const { result, atClose } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, role('button', 'Prepare export')), check({ kind: 'sizeAtLeast', value: 1 }),
    ], { read: ['download-status', 'input-events'] });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'no-download'], [2, 'skipped', undefined]]);
    assert.equal(atClose?.shown['download-status'], 'Preparing', 'the click was sent');
  });
});

describe('content checks on a file that is not text', () => {
  test('a PNG passes its media type and size checks', { criterion: 'AC-SPEC-31-06' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, role('link', 'Download logo')),
      check({ kind: 'mediaTypeEquals', value: 'image/png' }), check({ kind: 'sizeAtLeast', value: harness.files.logo.bytes.length }),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  // "PNG" is readable in the file's bytes, so reading them as text would wrongly pass.
  for (const assertion of [{ kind: 'contentContains', value: 'PNG' }, { kind: 'contentExcludes', value: 'GIF' }]) {
    test(`${assertion.kind} on a PNG fails with download-not-text`, { criterion: 'AC-SPEC-31-06' }, async () => {
      const { result } = await harness.runSteps(CDP_TARGET, [OPEN_DOWNLOADS, download(NAME, role('link', 'Download logo')), check(assertion), STILL_READY]);
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'download-not-text'], [3, 'skipped', undefined]]);
    });
  }
});

describe('downloads and popups no download step asked for', () => {
  test('in a plan with a download step, a later click that starts a download fails with unsupported-step and keeps no file', { criterion: 'AC-SPEC-31-09' }, async () => {
    const watch = storedAtClose(harness.files.invoices.marker);
    const ran = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, EXPORT_CSV), check({ kind: 'sizeAtLeast', value: 1 }), click(role('link', 'Export invoices')), STILL_READY,
    ], { beforeClose: watch.beforeClose });
    assert.equal(ran.result.state, 'Failed');
    assert.deepEqual(outcomes(ran.result), [
      [0, 'passed', undefined], [1, 'passed', undefined], [2, 'passed', undefined], [3, 'failed', 'unsupported-step'], [4, 'skipped', undefined],
    ]);
    assert.deepEqual(watch.found, [], 'the clicked download was discarded');
    assert.deepEqual(filesHolding(harness.files.invoices.marker, ran.startedAt), []);
  });

  test('in a plan with no download step, a click that starts a download still fails with unsupported-step and keeps no file', { criterion: 'AC-SPEC-31-09' }, async () => {
    const watch = storedAtClose(harness.files.invoices.marker);
    const ran = await harness.runSteps(CDP_TARGET, [OPEN_DOWNLOADS, click(role('link', 'Export invoices')), STILL_READY], { beforeClose: watch.beforeClose });
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined]]);
    assert.deepEqual(watch.found, []);
  });

  test('a download step whose click opens a popup fails with unsupported-step, and the popup does not stay open', { criterion: 'AC-SPEC-31-09' }, async () => {
    const { result, atClose } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, role('button', 'Open help')), check({ kind: 'sizeAtLeast', value: 1 }), STILL_READY,
    ], {
      read: ['popup-state', 'input-events'],
      // The page checks its handle on the popup every 50 ms; give it time to see the popup closed.
      beforeClose: () => new Promise((resolve) => setTimeout(resolve, 500)),
    });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
    assert.notEqual(atClose?.shown['input-events'], '0', 'the click was sent');
    assert.notEqual(atClose?.shown['popup-state'], 'open', 'the popup was closed or never opened');
  });
});

describe('the runtime guard on a download step', () => {
  // The control's test id hides its name from the static check; only the runtime guard sees it.
  test('a download from a control named "Delete account" ends the run Denied, with no input event and no request for the file', { criterion: 'AC-SPEC-31-10' }, async () => {
    const { result, atClose, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, testId('danger-export')), check({ kind: 'sizeAtLeast', value: 1 }),
    ]);
    assert.equal(result.state, 'Denied');
    assert.deepEqual(result.denial, { rule: 'irreversible-action', stepIndex: 1 });
    assert.equal(result.steps[1]?.code, 'policy-denied');
    assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
    assert.ok(!requestedPaths.includes(harness.files.projects.path), 'the file was never requested');
  });

  // Counter-example: the same file from a control named "Export CSV" is downloaded.
  test('counter-example: the same file from a control named "Export CSV" is clicked, fetched and checked', { criterion: 'AC-SPEC-31-10' }, async () => {
    const { result, atClose, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      OPEN_DOWNLOADS, download(NAME, testId('safe-export')), check({ kind: 'sizeAtLeast', value: 1 }),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.notEqual(atClose?.shown['input-events'], '0');
    assert.ok(requestedPaths.includes(harness.files.projects.path));
  });
});
