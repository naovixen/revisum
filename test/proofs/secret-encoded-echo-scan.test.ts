// No echo of a short secret survives into what a run keeps, however the page encodes it. A
// careless fixture page echoes what was typed into its token field inside longer encoded texts: a
// Basic authorisation header at each of the three byte offsets a base64 group allows, a form body
// as URLSearchParams writes it, and a query parameter with lower-case percent escapes. The secrets
// are fresh fakes of 8 and 10 characters holding a space, "/" and "!", so every encoding changes
// them. Each run checks one echo with a deliberately wrong expectation, so the run keeps what it
// observed. Kept text is judged twice: by holdsSecret, which decodes it without the engine, and by
// the leak scan over every result and event log beside a planted canary.
// The control types a plain text into the plain note field instead, and each of its echoes does
// reach the kept observation, so every echo on the page is live.
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
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import { FIXED_TIME_MILLISECONDS, SEED, makeDrivers, makeProjectFile } from '../support/signup-harness.ts';
import { holdsSecret } from '../unit/engine/echo-page-driver.ts';
import { fakeEnvironmentStore, fakeSecretOfLength, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';

const TIMEOUT = 300_000;
const TARGETS = ['playwright-chromium', 'cdp-chromium'] as const;
// The echo elements on the fixture page.
const ECHOES = ['basic-offset-0', 'basic-offset-1', 'basic-offset-2', 'form', 'lower-hex'] as const;
const SECRET_LENGTHS = [8, 10] as const;
const SECRET = 'ACCOUNT_TOKEN';
const CANARY = 'LEAK_SCAN_CANARY';

type Ran = { readonly result: RunResult; readonly eventLines: string };

let server: FixtureServer;
let project: Project;
let trusted: TrustedProject;
let folder: string;

before(async () => {
  server = await startFixtureServer(join(FIXTURES, 'encoded-echo-app'));
  const projectFile = { ...makeProjectFile(server.origin), secretNames: [SECRET] };
  const parsed = parseProject(projectFile);
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  project = parsed.value;
  trusted = await trustedProjectFrom(projectFile);
  folder = mkdtempSync(join(tmpdir(), 'encoded-echo-scan-'));
});
after(async () => {
  await server.close();
  rmSync(folder, { recursive: true, force: true });
});

// A fresh text of `length` characters holding a "/", a space and a "!" among letters: "ab/cd e!"
// for 8, "ab/cd efg!" for 10. Letters only, so the privacy masker never mistakes digits for a number.
function encodableText(length: number): string {
  let letters = '';
  while (letters.length < length - 3) letters += fakeSecretOfLength(32).replace(/[^A-Za-z]/g, '');
  return `${letters.slice(0, 2)}/${letters.slice(2, 4)} ${letters.slice(4, length - 3)}!`;
}

const echoPlan = (targetId: string, echo: string, value: unknown, field: string) => ({
  version: '1.1',
  meta: { featureId: 'SECRETS-7', specReference: 'specs/secrets.md#encoded-echoes', title: `Encoded echo: ${echo}` },
  targets: [targetId],
  steps: [
    { type: 'navigate', url: '/' },
    { type: 'fill', locator: { by: 'label', label: field }, value },
    { type: 'click', locator: { by: 'role', role: 'button', name: 'Show echoes' } },
    { type: 'expect', locator: { by: 'testId', testId: `echo-${echo}` }, assert: { kind: 'textEquals', value: 'deliberately wrong' }, criterionId: 'secrets.echo-checked' },
  ],
});

function parsed(raw: unknown): Plan {
  const outcome = planParser(project)(raw);
  if (!outcome.ok) throw new Error(`test plan rejected: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
}

async function runEcho(targetId: string, echo: string, value: unknown, secretValue: string, field: string): Promise<Ran> {
  const events = memoryRunEventSink();
  const result = await run({
    plan: authorise(parsed(echoPlan(targetId, echo, value, field)), trusted), project, targetId: targetId as TargetId,
    baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, fixtures: server.fixtures,
    host: { platform: platform(), arch: arch() },
  }, {
    drivers: makeDrivers(), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events,
    secrets: fakeEnvironmentStore({ [SECRET]: secretValue }),
  });
  return { result, eventLines: events.read().map((event) => JSON.stringify(event)).join('\n') };
}

function writeOutputs(label: string, ran: Ran): string[] {
  const resultPath = join(folder, `${label}.result.json`);
  const eventsPath = join(folder, `${label}.events.jsonl`);
  writeFileSync(resultPath, JSON.stringify(ran.result, null, 2));
  writeFileSync(eventsPath, ran.eventLines);
  return [resultPath, eventsPath];
}

describe('encoded echoes of short secrets never reach a run\'s outputs', () => {
  for (const targetId of TARGETS) {
    for (const length of SECRET_LENGTHS) {
      test(`${targetId}: a ${length}-character secret leaves no decodable echo, and the scan finds only its canary`, { criterion: 'AC-SPEC-04-04', timeout: TIMEOUT }, async () => {
        const secretValue = encodableText(length);
        const outputs: string[] = [];
        for (const echo of ECHOES) {
          const ran = await runEcho(targetId, echo, { secretName: SECRET }, secretValue, 'Access token');
          const fill = ran.result.steps[1];
          const check = ran.result.steps[3];
          assert.equal(fill?.outcome, 'passed', `${echo}: the secret was typed (${JSON.stringify(fill)})`);
          assert.equal(check?.outcome, 'failed', `${echo}: the echo check failed as planned`);
          assert.ok(check?.observed !== undefined && check.observed.length > 0, `${echo}: the run kept an observation`);
          assert.equal(holdsSecret(check.observed, secretValue), false, `${echo}: the observation still holds the secret: ${check.observed}`);
          assert.equal(holdsSecret(JSON.stringify(ran.result), secretValue), false, `${echo}: the result still holds the secret`);
          assert.equal(holdsSecret(ran.eventLines, secretValue), false, `${echo}: the event log still holds the secret`);
          outputs.push(...writeOutputs(`${targetId}.${length}.${echo}`, ran));
        }

        const canaryValue = fakeSecretValue();
        const canaryPath = join(folder, `${targetId}.${length}.canary.json`);
        writeFileSync(canaryPath, JSON.stringify({ observed: `planted ${canaryValue}` }));
        const secret = resolvedSecret(SECRET, secretValue);
        const canary = resolvedSecret(CANARY, canaryValue);
        const leaks = leakScanner().scan([...outputs, canaryPath], [secret, canary]);
        assert.deepEqual(leaks.filter((leak) => leak.secret === secret.name), [], 'echoes of the secret in the outputs');
        assert.ok(leaks.some((leak) => leak.secret === canary.name && leak.file === canaryPath), 'the scan found its planted canary');
      });
    }

    // Literal text in the token field is refused as literal_secret, so the control types into the plain note field.
    test(`${targetId}: control: every encoded echo of a plain text typed into a plain field reaches the kept observation`, { criterion: 'AC-SPEC-04-04', timeout: TIMEOUT }, async () => {
      const plainText = encodableText(10);
      for (const echo of ECHOES) {
        const ran = await runEcho(targetId, echo, plainText, fakeSecretValue(), 'Note');
        const check = ran.result.steps[3];
        assert.equal(check?.outcome, 'failed', `${echo}: the echo check failed as planned`);
        assert.ok(check?.observed !== undefined && holdsSecret(check.observed, plainText), `${echo}: the observation should echo the plain text: ${check?.observed ?? '(none)'}`);
      }
    });
  }
});
