// The keys the own CDP driver holds down for a press step's modifiers. ControlOrMeta stands for
// the platform's command key: Meta on macOS and Control everywhere else; every other modifier is
// held as itself, in the order the plan writes them. The mapping is one pure function, so the
// macOS case is checked here without a Mac; the browser tests check Control on the Windows and
// Linux machines the suite runs on (test/contract/cdp-key-chords-and-lines.test.ts).
// The function is assumed to be exported by the driver package as
//   heldModifierKeys(modifiers: readonly Modifier[], platform: NodeJS.Platform): readonly ('Alt' | 'Control' | 'Meta' | 'Shift')[]
// and is looked up by name, so this file compiles before it exists.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Modifier } from '@revisum/contracts';
import * as cdpDriverPackage from '@revisum/driver-cdp';

type HeldModifierKeys = (modifiers: readonly Modifier[], platform: NodeJS.Platform) => readonly string[];

function heldModifierKeys(modifiers: readonly Modifier[], platform: NodeJS.Platform): readonly string[] {
  const exported: unknown = Object.getOwnPropertyDescriptor(cdpDriverPackage, 'heldModifierKeys')?.value;
  assert.equal(typeof exported, 'function', 'the driver package exports heldModifierKeys');
  return (exported as HeldModifierKeys)(modifiers, platform);
}

test('ControlOrMeta is held as Meta on macOS', { criterion: 'AC-SPEC-30-14' }, () => {
  assert.deepEqual(heldModifierKeys(['ControlOrMeta'], 'darwin'), ['Meta']);
});

for (const platform of ['linux', 'win32'] as const) {
  test(`ControlOrMeta is held as Control on ${platform}`, { criterion: 'AC-SPEC-30-14' }, () => {
    assert.deepEqual(heldModifierKeys(['ControlOrMeta'], platform), ['Control']);
  });
}

test('every other modifier is held as itself, in the order written, on every platform', { criterion: 'AC-SPEC-30-14' }, () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.deepEqual(heldModifierKeys(['Shift', 'Alt', 'Meta', 'Control'], platform), ['Shift', 'Alt', 'Meta', 'Control'], platform);
  }
});

test('ControlOrMeta keeps its place among the other modifiers', { criterion: 'AC-SPEC-30-14' }, () => {
  assert.deepEqual(heldModifierKeys(['Shift', 'ControlOrMeta', 'Alt'], 'darwin'), ['Shift', 'Meta', 'Alt']);
  assert.deepEqual(heldModifierKeys(['Shift', 'ControlOrMeta', 'Alt'], 'linux'), ['Shift', 'Control', 'Alt']);
});
