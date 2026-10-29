// No echo of a secret survives into what a run keeps. A careless fixture page echoes the secret
// typed into its token field in raw, URI, base64, base64url, prefix and case-changed forms; each
// run checks one echo with a deliberately wrong expectation, so the run keeps what it observed.
// The leak scan then runs over every result, event log and image the runs produced, beside a
// planted canary: it must find the canary and no echo of the secret.
// The control run types a plain text instead, and its echo does reach the result, so the probe can
// see a leak when there is one.
// Not covered here: the visual report, which a run cannot produce until the result model exists
// (SPEC-11, SPEC-12), and text drawn as pixels, which no text scan can read.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  defaultRedactor, leakScanner, parseProject, planParser, run,
  type Plan, type Project, type RunResult, type TargetId, type TrustedProject,
} from '@revisum/engine';
import { startFixtureServer, type FixtureServer } from '../support/fixture-server.ts';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import { FIXED_TIME_MILLISECONDS, SEED, makeDrivers, makeProjectFile } from '../support/signup-harness.ts';
import { echoesIn, fakeEnvironmentStore, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';

const TIMEOUT = 300_000;
// One target per driver package.
const TARGETS = ['playwright-chromium', 'cdp-chromium'] as const;
// The echo elements on the fixture page, one per leak form.
const ECHOES = ['raw', 'uri', 'base64', 'base64url', 'prefix', 'upper', 'lower'] as const;
const SECRET = 'ACCOUNT_TOKEN';
const CANARY = 'LEAK_SCAN_CANARY';

type Ran = { readonly result: RunResult; readonly eventLines: string; readonly images: readonly Uint8Array[] };

let server: FixtureServer;
let project: Project;
let trusted: TrustedProject;
let folder: string;

before(async () => {
  server = await startFixtureServer(join(FIXTURES, 'secret-echo-app'));
  const projectFile = { ...makeProjectFile(server.origin), secretNames: [SECRET] };
  const parsed = parseProject(projectFile);
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  project = parsed.value;
  trusted = await trustedProjectFrom(projectFile);
  folder = mkdtempSync(join(tmpdir(), 'leak-scan-'));
});
after(async () => {
  await server.close();
  rmSync(folder, { recursive: true, force: true });
});

// Types `value` into the token field, shows the echoes, keeps a screenshot, then checks one echo
// against a text it can never equal, so the failed step keeps what it observed.
const echoPlan = (targetId: string, echo: string, value: unknown, field = 'Access token') => ({
  version: '1.1',
  meta: { featureId: 'SECRETS-2', specReference: 'specs/secrets.md#echoes', title: `Token echo: ${echo}` },
  targets: [targetId],
  steps: [
    { type: 'navigate', url: '/' },
    { type: 'fill', locator: { by: 'label', label: field }, value },
    { type: 'capture', name: 'token-typed' },
    { type: 'click', locator: { by: 'role', role: 'button', name: 'Show echoes' } },
    { type: 'expect', locator: { by: 'testId', testId: `echo-${echo}` }, assert: { kind: 'textEquals', value: 'deliberately wrong' }, criterionId: 'secrets.echo-checked' },
  ],
});

function parsed(raw: unknown): Plan {
  const outcome = planParser(project)(raw);
  if (!outcome.ok) throw new Error(`test plan rejected: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
}

async function runEcho(targetId: string, echo: string, value: unknown, secretValue: string, field?: string): Promise<Ran> {
  const events = memoryRunEventSink();
  const artifacts = memoryArtifactStore();
  const result = await run({
    plan: authorise(parsed(echoPlan(targetId, echo, value, field)), trusted), project, targetId: targetId as TargetId,
    baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, fixtures: server.fixtures,
    host: { platform: platform(), arch: arch() },
  }, {
    drivers: makeDrivers(), clock: systemClock, artifacts, redactor: defaultRedactor(), audit: memoryEventSink(), events,
    secrets: fakeEnvironmentStore({ [SECRET]: secretValue }),
  });
  const images = artifacts.references().flatMap((reference) => {
    const bytes = artifacts.get(reference.name);
    return bytes === undefined ? [] : [bytes];
  });
  return { result, eventLines: events.read().map((event) => JSON.stringify(event)).join('\n'), images };
}

// Writes each run's result, event log and images to the scan folder and returns their paths.
function writeOutputs(label: string, ran: Ran): string[] {
  const paths = [join(folder, `${label}.result.json`), join(folder, `${label}.events.jsonl`)];
  writeFileSync(paths[0] ?? '', JSON.stringify(ran.result, null, 2));
  writeFileSync(paths[1] ?? '', ran.eventLines);
  ran.images.forEach((image, index) => {
    const path = join(folder, `${label}.image-${index}.png`);
    writeFileSync(path, image);
    paths.push(path);
  });
  return paths;
}

describe('secret echoes never reach a run\'s outputs', () => {
  for (const targetId of TARGETS) {
    test(`${targetId}: the scan finds the planted canary and no echo of the secret in any form`, { criterion: 'AC-SPEC-04-04', timeout: TIMEOUT }, async () => {
      const secretValue = fakeSecretValue();
      const outputs: string[] = [];
      for (const echo of ECHOES) {
        const ran = await runEcho(targetId, echo, { secretName: SECRET }, secretValue);
        // The probe is live: the secret was typed and the wrong expectation failed with an observation.
        const fill = ran.result.steps[1];
        const check = ran.result.steps[4];
        assert.equal(fill?.outcome, 'passed', `${echo}: the secret was typed (${JSON.stringify(fill)})`);
        assert.equal(check?.outcome, 'failed', `${echo}: the echo check failed as planned`);
        assert.ok(check?.observed !== undefined && check.observed.length > 0, `${echo}: the run kept an observation`);
        // Checked directly, without the engine's scanner.
        assert.deepEqual(echoesIn(JSON.stringify(ran.result), secretValue), [], `${echo}: forms in the result`);
        assert.deepEqual(echoesIn(ran.eventLines, secretValue), [], `${echo}: forms in the event log`);
        outputs.push(...writeOutputs(`${targetId}.${echo}`, ran));
      }

      const canaryValue = fakeSecretValue();
      const canaryPath = join(folder, `${targetId}.canary.json`);
      writeFileSync(canaryPath, JSON.stringify({ observed: `planted ${canaryValue}` }));
      const secret = resolvedSecret(SECRET, secretValue);
      const canary = resolvedSecret(CANARY, canaryValue);

      const leaks = leakScanner().scan([...outputs, canaryPath], [secret, canary]);
      assert.deepEqual(leaks.filter((leak) => leak.secret === secret.name), [], 'echoes of the secret in the outputs');
      const canaryLeaks = leaks.filter((leak) => leak.secret === canary.name);
      assert.ok(canaryLeaks.length > 0, 'the scan found its planted canary');
      assert.ok(canaryLeaks.every((leak) => leak.file.endsWith(`${targetId}.canary.json`)), 'the canary is found only where it was planted');
      assert.ok(outputs.some((path) => path.endsWith('.png')), 'the scan covered at least one image');
    });

    // Literal text in the token field is itself refused as literal_secret, so the control types into the plain note field.
    test(`${targetId}: control: a plain text typed into a plain field does reach the kept observation`, { criterion: 'AC-SPEC-04-04', timeout: TIMEOUT }, async () => {
      // Letters only, so the privacy masker never mistakes a run of digits for a phone number.
      const plainText = `plain${fakeSecretValue().replace(/[^A-Za-z]/g, '')}`;
      const ran = await runEcho(targetId, 'raw', plainText, fakeSecretValue(), 'Note');
      const check = ran.result.steps[4];
      assert.equal(check?.outcome, 'failed');
      assert.ok(check?.observed?.includes(plainText), `the observation should echo the plain text: ${check?.observed ?? '(none)'}`);
    });
  }
});
