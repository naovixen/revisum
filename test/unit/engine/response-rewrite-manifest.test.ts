// The run manifest records each browser mutant's response rewrite the egress proxy applied, by
// origin and name, so a mutated run can never pass for a plain one. A run with no rewrite has no
// such field, so its manifest and manifest hash are exactly what they were before mutants existed.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest, manifestHash, type AdapterInfo, type Plan, type Target } from '@revisum/engine';
import { defaultParser, signupPlan, testProject } from './plan-examples.ts';

const FIXTURE_ORIGIN = 'http://127.0.0.1:4310';

function parsedSignupPlan(): Plan {
  const parsed = defaultParser()(signupPlan());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.value;
}

function firstTarget(): Target {
  const target = testProject().matrix[0];
  assert.ok(target !== undefined);
  return target;
}

const ADAPTER: AdapterInfo = { id: 'cdp', version: '0.1.0', protocol: 'Chrome DevTools Protocol (raw WebSocket)' };

const baseInputs = () => ({
  plan: parsedSignupPlan(), target: firstTarget(), adapter: ADAPTER, browser: { name: 'chromium', version: '156.0.8078.47' },
  seed: 42, fixedTimeMilliseconds: Date.UTC(2026, 9, 29, 9, 0, 0), fixtures: [], host: { platform: 'linux', arch: 'x64' },
});

test('each rewrite the proxy applied is recorded in the manifest by origin and name', { criterion: 'AC-SPEC-07-07' }, () => {
  const rewrites = [{ origin: FIXTURE_ORIGIN, name: 'heading-changed' }, { origin: FIXTURE_ORIGIN, name: 'status-flipped' }];
  const manifest = buildManifest({ ...baseInputs(), responseRewrites: rewrites });
  assert.deepEqual(manifest.responseRewrites, rewrites);
});

test('a mutated run\'s manifest hash differs from the same run without the rewrite', { criterion: 'AC-SPEC-07-07' }, () => {
  const plain = buildManifest(baseInputs());
  const mutated = buildManifest({ ...baseInputs(), responseRewrites: [{ origin: FIXTURE_ORIGIN, name: 'heading-changed' }] });
  assert.notEqual(manifestHash(mutated), manifestHash(plain));
});

test('a run with no rewrite has no rewrite field, so its manifest hash is unchanged', { criterion: 'AC-SPEC-07-07' }, () => {
  const plain = buildManifest(baseInputs());
  const empty = buildManifest({ ...baseInputs(), responseRewrites: [] });
  assert.ok(!Object.hasOwn(plain, 'responseRewrites'));
  assert.ok(!Object.hasOwn(empty, 'responseRewrites'));
  assert.equal(manifestHash(empty), manifestHash(plain));
});
