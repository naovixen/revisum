// The trusted project's settings for downloads: limits.maximumDownloadBytes caps a downloaded
// file (5 MiB unless the project says otherwise, and never more than 100 MiB), and
// evidence.keepDownloads, off unless the project turns it on, decides whether a download's
// redacted text is kept. What the driver does at the cap, and what is kept, come with the
// downloads themselves.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject, type Project } from '@revisum/engine';
import { projectFileWith } from './run-value-examples.ts';

const MEBIBYTE = 1024 * 1024;

function parsed(fields: Record<string, unknown> = {}, limits: Readonly<Record<string, number>> = {}): Project {
  const outcome = parseProject(projectFileWith(fields, limits));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.value;
}

const refusal = (fields: Record<string, unknown>, limits: Readonly<Record<string, number>> = {}): string[] => {
  const outcome = parseProject(projectFileWith(fields, limits));
  assert.equal(outcome.ok, false, 'the project was accepted');
  return outcome.ok ? [] : outcome.error.map((error) => `${error.code} ${error.path}`);
};

// The project's fields as plain data, read by name.
const limitsOf = (project: Project): Readonly<Record<string, unknown>> => project.limits;
// The project's keepDownloads setting; undefined when it has no evidence section holding one.
const keepDownloadsOf = (project: Project): unknown => {
  const fields: Readonly<Record<string, unknown>> = project;
  const evidence = fields['evidence'];
  return typeof evidence === 'object' && evidence !== null && 'keepDownloads' in evidence ? evidence.keepDownloads : undefined;
};

// ---- maximumDownloadBytes -----------------------------------------------------------------------

test('a project that sets no download limit caps downloads at 5 MiB', { criterion: 'AC-SPEC-31-06' }, () => {
  assert.equal(limitsOf(parsed())['maximumDownloadBytes'], 5 * MEBIBYTE);
});

test('a project may set the download limit from 1 byte up to 100 MiB', { criterion: 'AC-SPEC-31-06' }, () => {
  for (const bytes of [1, 64 * 1024, 100 * MEBIBYTE]) {
    assert.equal(limitsOf(parsed({}, { maximumDownloadBytes: bytes }))['maximumDownloadBytes'], bytes);
  }
});

test('a download limit over 100 MiB, of 0, or not a whole number is refused at the limit', { criterion: 'AC-SPEC-31-06' }, () => {
  for (const bytes of [100 * MEBIBYTE + 1, 0, -1, 1.5]) {
    const errors = refusal({}, { maximumDownloadBytes: bytes });
    assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.limits.maximumDownloadBytes'], String(bytes));
    // A known limit with a bad value, not a field the project file does not have.
    assert.notEqual(errors[0]?.split(' ')[0], 'unknown_field', String(bytes));
  }
});

// ---- evidence.keepDownloads ---------------------------------------------------------------------

test('a project with no evidence section keeps no download content', { criterion: 'AC-SPEC-31-08' }, () => {
  assert.equal(keepDownloadsOf(parsed()), false);
});

test('a project may turn keepDownloads on, and an empty evidence section leaves it off', { criterion: 'AC-SPEC-31-08' }, () => {
  assert.equal(keepDownloadsOf(parsed({ evidence: { keepDownloads: true } })), true);
  assert.equal(keepDownloadsOf(parsed({ evidence: {} })), false);
});

test('keepDownloads that is not true or false is refused as wrong_type', { criterion: 'AC-SPEC-31-08' }, () => {
  for (const keepDownloads of ['yes', 1, null]) {
    assert.deepEqual(refusal({ evidence: { keepDownloads } }), ['wrong_type $.evidence.keepDownloads'], JSON.stringify(keepDownloads));
  }
});

test('the evidence section is closed: an unknown key in it is refused', { criterion: 'AC-SPEC-31-08' }, () => {
  assert.deepEqual(refusal({ evidence: { keepDownloads: false, keepScreenshotsUnmasked: true } }), ['unknown_field $.evidence.keepScreenshotsUnmasked']);
});
