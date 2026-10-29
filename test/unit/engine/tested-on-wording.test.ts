// "Tested on" wording: what a report says a run was tested on comes from the target's engine,
// version, device profile and fidelity, so an emulated phone viewport never reads as a phone and
// a patched WebKit never reads as Safari.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { testedOn, type Target } from '@revisum/engine';
import { type JsonRecord } from './plan-examples.ts';
import { projectWith, targetInput, targetOf } from './target-examples.ts';

const BUILD = { version: '156.0.7258.5', executablePath: '/browsers/chromium/chrome' };

const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'] as const;
const DEVICES = ['desktop-1280', 'laptop-1024', 'tablet-820', 'phone-390'] as const;
const FIDELITIES = ['engine', 'engine-emulated', 'emulator', 'simulator', 'real'] as const;

// Every engine on every device with its default fidelity, then every fidelity given explicitly.
const matrix: JsonRecord[] = [
  ...ENGINE_NAMES.flatMap((engine) => DEVICES.map((device) => targetInput(`${engine}-${device}`, 'fake', engine, device))),
  ...ENGINE_NAMES.flatMap((engine) => FIDELITIES.map((fidelity) =>
    targetInput(`${engine}-phone-${fidelity}`, 'fake', engine, 'phone-390', { fidelity }))),
  targetInput('chromium-phone-versioned', 'fake', 'chromium', 'phone-390', { version: '156.0.7258.5' }),
];
const project = projectWith(matrix);
const allTargets: readonly Target[] = project.matrix;
const target = (id: string): Target => targetOf(project, id);

// The words a report must never use for a target this core ran: it claims a device or a browser
// that was not there. "not Safari" is the one allowed use of "Safari".
const MISLEADING_WORDS = [/android/i, /iphone/i, /\bios\b/i, /safari/i] as const;
const misleadingWords = (wording: string): readonly string[] =>
  MISLEADING_WORDS.filter((pattern) => pattern.test(wording.replaceAll('not Safari', ''))).map(String);

describe('the wording names engine, version, device and fidelity', () => {
  test('a Chromium phone target reads "Chromium 156, phone viewport (emulated)"', { criterion: 'AC-SPEC-05-06' }, () => {
    assert.equal(testedOn(target('chromium-phone-390'), BUILD), 'Chromium 156, phone viewport (emulated)');
  });

  test('the version may come from the target itself when no build is given', { criterion: 'AC-SPEC-05-06' }, () => {
    assert.equal(testedOn(target('chromium-phone-versioned')), 'Chromium 156, phone viewport (emulated)');
  });

  test('without a known version, the wording names no version', { criterion: 'AC-SPEC-05-06' }, () => {
    const wording = testedOn(target('chromium-phone-390'));
    assert.ok(wording.startsWith('Chromium'), wording);
    assert.ok(wording.endsWith('phone viewport (emulated)'), wording);
    assert.ok(!/\d{2,}/.test(wording), `no invented version: ${wording}`);
  });

  test('a phone profile with no fidelity given reads exactly as one declared engine-emulated', { criterion: 'AC-SPEC-05-06' }, () => {
    for (const engine of ENGINE_NAMES) {
      assert.equal(testedOn(target(`${engine}-phone-390`), BUILD), testedOn(target(`${engine}-phone-engine-emulated`), BUILD));
    }
  });

  test('engine fidelity adds nothing in brackets; any other fidelity adds its own bracketed note', { criterion: 'AC-SPEC-05-06' }, () => {
    const desktop = testedOn(target('chromium-desktop-1280'), BUILD);
    assert.ok(desktop.startsWith('Chromium 156, '), desktop);
    assert.ok(!desktop.includes('('), `no fidelity note on a desktop engine target: ${desktop}`);
    assert.ok(!testedOn(target('chromium-phone-engine'), BUILD).includes('('));
    const notes = FIDELITIES.filter((fidelity) => fidelity !== 'engine')
      .map((fidelity) => testedOn(target(`chromium-phone-${fidelity}`), BUILD))
      .map((wording) => /\(([^()]+)\)$/.exec(wording)?.[1]);
    assert.ok(notes.every((note) => note !== undefined), `each non-engine fidelity ends in a bracketed note: ${JSON.stringify(notes)}`);
    assert.equal(new Set(notes).size, notes.length, 'each fidelity has its own note');
  });

  test('the wording is a pure function of its inputs', { criterion: 'AC-SPEC-05-06' }, () => {
    for (const each of allTargets) assert.equal(testedOn(each, BUILD), testedOn(each, BUILD));
  });
});

describe('the wording never claims a device or browser that was not there', () => {
  test('WebKit always reads "patched WebKit, not Safari"', { criterion: 'AC-SPEC-05-06' }, () => {
    for (const each of allTargets.filter((candidate) => candidate.engine === 'webkit')) {
      for (const wording of [testedOn(each), testedOn(each, { version: '26.0', executablePath: '/browsers/webkit/run' })]) {
        assert.ok(wording.includes('patched WebKit'), `${each.id}: ${wording}`);
        assert.ok(wording.includes('not Safari'), `${each.id}: ${wording}`);
      }
    }
  });

  test('no target, with or without a build, reads as an Android phone, an iPhone, iOS or Safari', { criterion: 'AC-SPEC-05-06' }, () => {
    for (const each of allTargets) {
      for (const wording of [testedOn(each), testedOn(each, BUILD)]) {
        assert.deepEqual(misleadingWords(wording), [], `${each.id}: ${wording}`);
      }
    }
  });

  test('counter-example: the check catches the wording a silent stand-in would use', { criterion: 'AC-SPEC-05-06' }, () => {
    for (const wording of ['Chrome on Android phone', 'Safari 26, iPhone 15', 'WebKit on iOS', 'patched WebKit (Safari)']) {
      assert.notDeepEqual(misleadingWords(wording), [], wording);
    }
    assert.deepEqual(misleadingWords('patched WebKit, not Safari, phone viewport (emulated)'), []);
  });
});
