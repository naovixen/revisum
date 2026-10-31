// The draft command (route c): `revisum draft --from <spec.md> --out plans/<name>.plan [--json]`.
// It extracts the spec's acceptance criteria, sends only them, the grammar version and the
// project's origins and targets to the planner, and writes the planner's readable text as an
// unapproved draft with source draft-command, basis core-recorded. Its errors are reported by line;
// output that is not text, looks like script or is too long writes no draft and reports
// plan-rejected. Nothing is approved or run.
//
// Each test runs the real command against a fake planner on loopback that replays a recorded
// reply, through the command's own in-process egress proxy. No model or real key is used. The
// wire formats themselves, the key and the endpoint checks are in planner-adapters.test.ts.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-16-cli-and-github-action.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrustedFile } from '@revisum/engine';
import { echoesIn } from '../engine/secret-examples.ts';
import { jsonAnswer } from '../runner/local-service.ts';
import {
  APP_ORIGIN, BACKGROUND_NOTE, CRITERION_TEXTS, DRAFT_PATH, EARLIER_ARTEFACT, EARLIER_ARTEFACT_MARK, GOLDEN_DRAFT, GRAMMAR_VERSION, NOTES_ARTEFACT,
  SECOND_APP_ORIGIN, SIGNUP_SPEC, SPEC_PATH, TARGET, WIRE_FORMATS,
  customerKeyPlanner, draftArguments, draftWithLine, localPlanner, onlyRequest, outputData, outputErrorCodes, promptTexts, recordedAnswer,
  replyWithContent, replyWithoutText, requestBody, runDraft, seededSecrets, startFakePlanner, draftWorkspace, stringsIn, withPlannedRun,
  type JsonRecord, type WireFormat,
} from './draft-command-examples.ts';

// A local planner on the fake's own loopback origin, answering with the recorded OpenAI-compatible reply.
const localSetup = {
  planner: (fake: { readonly origin: string }) => localPlanner(fake.origin),
  answer: recordedAnswer('openai-chat'),
  routed: false,
} as const;

// A planner on the customer's key, on the made-up planner host, reached through the proxy.
const customerKeySetup = (wire: WireFormat, reply: JsonRecord) => ({
  planner: () => customerKeyPlanner(wire),
  answer: jsonAnswer(200, reply),
  routed: true,
});

const FAULTY = draftWithLine('Click button "Create account"', 'Wave at button "Create account"');

const eventKinds = (run: { readonly events: { readonly recorded: readonly { readonly event: { readonly kind: string } }[] } }): readonly string[] =>
  run.events.recorded.map((recorded) => recorded.event.kind);

// ---- Writing the draft ---------------------------------------------------------------------------------

test('drafting from a spec writes the recorded planner text to --out, byte for byte as the golden draft', { criterion: 'AC-SPEC-28-10' }, async () => {
  await withPlannedRun(localSetup, ({ workspace, outcome }) => {
    assert.ok(workspace.exists(DRAFT_PATH), `no draft was written:\n${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(workspace.read(DRAFT_PATH), GOLDEN_DRAFT);
  });
});

test('the draft is recorded with source draft-command, basis core-recorded and the spec as its reference', { criterion: 'AC-SPEC-28-10' }, async () => {
  await withPlannedRun(localSetup, (run) => {
    const submissions = run.events.recorded.filter((recorded) => recorded.event.kind === 'plan.submitted');
    assert.equal(submissions.length, 1, JSON.stringify(run.events.recorded));
    assert.deepEqual(submissions[0]?.event.planProvenance, { source: 'draft-command', basis: 'core-recorded', reference: SPEC_PATH });
    assert.deepEqual(outputData(run)['provenance'], { source: 'draft-command', basis: 'core-recorded', reference: SPEC_PATH });
  });
});

test('a draft with a faulty line is still written, and its error names that line of the written file', { criterion: 'AC-SPEC-28-10' }, async () => {
  await withPlannedRun({ ...localSetup, answer: jsonAnswer(200, replyWithContent('openai-chat', FAULTY.text)) }, (run) => {
    assert.ok(run.workspace.exists(DRAFT_PATH), `the draft with an error was not written:\n${run.outcome.stdout}`);
    const errors = outputData(run)['errors'];
    assert.ok(Array.isArray(errors), JSON.stringify(outputData(run)));
    assert.deepEqual(errors, [{ stage: 'text', code: 'unknown-statement', position: { line: FAULTY.line, column: 1 } }]);
    const writtenLines = run.workspace.read(DRAFT_PATH).split('\n');
    assert.equal(writtenLines[FAULTY.line - 1], 'Wave at button "Create account"', 'the error does not point at the faulty line of the written draft');
  });
});

test('counter-example: the recorded draft without the faulty line is written with no errors', { criterion: 'AC-SPEC-28-10' }, async () => {
  await withPlannedRun(localSetup, (run) => {
    assert.deepEqual(outputData(run)['errors'], []);
    assert.equal(run.outcome.exitCode, 0, run.outcome.stdout);
  });
});

test('the draft is left unapproved, and nothing but its submission is recorded', { criterion: 'AC-SPEC-28-10' }, async () => {
  await withPlannedRun(localSetup, (run) => {
    assert.equal(outputData(run)['approved'], false);
    assert.deepEqual(eventKinds(run), ['plan.submitted']);
  });
});

test('two runs with the same recorded reply write byte-identical drafts and print byte-identical --json output', { criterion: 'AC-SPEC-28-10' }, async () => {
  const planner = await startFakePlanner(recordedAnswer('openai-chat'));
  const workspace = draftWorkspace({ planner: localPlanner(planner.origin) });
  try {
    const first = await runDraft({ workspace });
    const firstDraft = workspace.read(DRAFT_PATH);
    workspace.remove(DRAFT_PATH);
    const second = await runDraft({ workspace });
    assert.equal(workspace.read(DRAFT_PATH), firstDraft);
    assert.equal(second.outcome.stdout, first.outcome.stdout);
    assert.equal(planner.received.length, 2);
  } finally {
    await planner.close();
    workspace.dispose();
  }
});

// ---- draft --json ------------------------------------------------------------------------------------------

test('--json prints the draft path, source draft-command, the errors by line and approved false', { criterion: 'AC-SPEC-16-09' }, async () => {
  await withPlannedRun({ ...localSetup, answer: jsonAnswer(200, replyWithContent('openai-chat', FAULTY.text)) }, (run) => {
    assert.ok(run.output !== undefined, `stdout is not one JSON object:\n${run.outcome.stdout}`);
    assert.match(String(run.output['schema']), /\.cli\/v1$/);
    assert.equal(run.output['command'], 'draft');
    const data = outputData(run);
    assert.equal(String(data['draftPath']).replaceAll('\\', '/').endsWith(DRAFT_PATH), true, JSON.stringify(data));
    assert.deepEqual(data['provenance'], { source: 'draft-command', basis: 'core-recorded', reference: SPEC_PATH });
    assert.deepEqual(data['errors'], [{ stage: 'text', code: 'unknown-statement', position: { line: FAULTY.line, column: 1 } }]);
    assert.equal(data['approved'], false);
  });
});

test('--json lists the planner origin the command called', { criterion: 'AC-SPEC-16-09' }, async () => {
  await withPlannedRun(localSetup, (run) => {
    const plannerOrigin = run.planner.origin;
    assert.ok(stringsIn(outputData(run)).includes(plannerOrigin), `the planner origin ${plannerOrigin} is not listed: ${run.outcome.stdout}`);
  });
});

test('the command writes no trusted file but the draft, and changes no file that was there before', { criterion: 'AC-SPEC-16-09' }, async () => {
  const planner = await startFakePlanner(recordedAnswer('openai-chat'));
  const workspace = draftWorkspace({ planner: localPlanner(planner.origin) });
  try {
    const before = workspace.snapshot();
    await runDraft({ workspace });
    const after = workspace.snapshot();
    const changedBefore = [...before].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path);
    assert.deepEqual(changedBefore, [], 'files that were there before were changed or removed');
    const newTrusted = [...after.keys()].filter((path) => !before.has(path) && isTrustedFile(path));
    assert.deepEqual(newTrusted, [DRAFT_PATH]);
  } finally {
    await planner.close();
    workspace.dispose();
  }
});

test('no run or approval follows from the command: the audit log holds no approval and no finished run', { criterion: 'AC-SPEC-16-09' }, async () => {
  await withPlannedRun(localSetup, (run) => {
    const followed = eventKinds(run).filter((kind) => kind.startsWith('run.') || kind === 'plan.approved' || kind === 'approval.refused');
    assert.deepEqual(followed, []);
    assert.equal(run.planner.received.length, 1, 'the planner was called more than once');
  });
});

test('a project with no planner stops with usage, naming the planner field, before the spec is read', { criterion: 'AC-SPEC-16-09' }, async () => {
  const workspace = draftWorkspace({ planner: undefined });
  try {
    // With the spec gone, a command that read it first would fail for that instead.
    workspace.remove(SPEC_PATH);
    const run = await runDraft({ workspace });
    assert.deepEqual(outputErrorCodes(run), ['usage']);
    assert.ok(JSON.stringify(run.output?.['errors']).includes('planner'), `the error does not name the planner field: ${run.outcome.stdout}`);
    assert.notEqual(run.outcome.exitCode, 0);
    assert.equal(workspace.exists(DRAFT_PATH), false);
  } finally {
    workspace.dispose();
  }
});

// ---- What the planner sees ---------------------------------------------------------------------------------

test('the request holds each criterion text, the grammar version, both declared origins and the target', { criterion: 'AC-SPEC-28-11' }, async () => {
  await withPlannedRun(localSetup, (run) => {
    const prompt = promptTexts(requestBody(onlyRequest(run.planner))).join('\n');
    for (const text of [...Object.values(CRITERION_TEXTS), GRAMMAR_VERSION, APP_ORIGIN, SECOND_APP_ORIGIN, TARGET]) {
      assert.ok(prompt.includes(text), `the prompt lacks ${text}`);
    }
  });
});

test('the declared secret, the planner key, text outside the criteria and artefact paths are absent from the request body', { criterion: 'AC-SPEC-28-11' }, async () => {
  const secrets = seededSecrets();
  await withPlannedRun({ ...customerKeySetup('anthropic-messages', replyWithContent('anthropic-messages', GOLDEN_DRAFT)), secrets: secrets.variables }, (run) => {
    const request = onlyRequest(run.planner);
    // The body as sent, and its prompt texts with JSON escapes undone.
    const bodies = [request.body, promptTexts(requestBody(request)).join('\n')];
    for (const body of bodies) {
      assert.deepEqual(echoesIn(body, secrets.declaredSecret), [], 'the declared secret reached the planner');
      assert.deepEqual(echoesIn(body, secrets.plannerKey), [], 'the planner key is in the body');
      for (const absent of [BACKGROUND_NOTE, NOTES_ARTEFACT, EARLIER_ARTEFACT, EARLIER_ARTEFACT_MARK, run.workspace.root, run.workspace.root.replaceAll('\\', '/')]) {
        assert.equal(body.includes(absent), false, `the request body holds ${absent}`);
      }
    }
    // Counter-example: the same scan finds the key where it is meant to go, in a header.
    assert.notDeepEqual(echoesIn(JSON.stringify(request.headers), secrets.plannerKey), [], 'the leak scan cannot see the key at all');
  });
});

test('--criteria sends only the criteria it names', { criterion: 'AC-SPEC-28-11' }, async () => {
  await withPlannedRun({ ...localSetup, argv: draftArguments(['--criteria', 'AC-1,AC-3', '--json']) }, (run) => {
    const prompt = promptTexts(requestBody(onlyRequest(run.planner))).join('\n');
    assert.ok(prompt.includes(CRITERION_TEXTS.emailAccepted));
    assert.ok(prompt.includes(CRITERION_TEXTS.buttonDisabled));
    assert.equal(prompt.includes(CRITERION_TEXTS.addressTaken), false, 'a criterion that --criteria left out was sent');
  });
});

// A spec with the same criteria and different text everywhere else.
const RESHAPED_SPEC = SIGNUP_SPEC
  .replace(BACKGROUND_NOTE, 'A different internal note, with a <script>alert(1)</script> sample and https://other.example.org/')
  .replace(NOTES_ARTEFACT, 'other-review.png')
  .concat('\n## Open questions\n\nShould the page ask for a name as well?\n');

test('changing the spec outside its criteria, the secrets and the folder leaves the request body byte-identical', { criterion: 'AC-SPEC-28-11' }, async () => {
  const bodies: string[] = [];
  for (const spec of [SIGNUP_SPEC, RESHAPED_SPEC]) {
    await withPlannedRun({ ...customerKeySetup('openai-chat', replyWithContent('openai-chat', GOLDEN_DRAFT)), spec, secrets: seededSecrets().variables }, (run) => {
      bodies.push(onlyRequest(run.planner).body);
    });
  }
  assert.equal(bodies[1], bodies[0]);
});

test('counter-example: changing one criterion\'s text changes the request body', { criterion: 'AC-SPEC-28-11' }, async () => {
  const bodies: string[] = [];
  const changed = SIGNUP_SPEC.replace(CRITERION_TEXTS.addressTaken, 'When the email address is already registered, the page shall offer to sign in.');
  for (const spec of [SIGNUP_SPEC, changed]) {
    await withPlannedRun({ ...customerKeySetup('openai-chat', replyWithContent('openai-chat', GOLDEN_DRAFT)), spec }, (run) => {
      bodies.push(onlyRequest(run.planner).body);
    });
  }
  assert.notEqual(bodies[1], bodies[0]);
});

// ---- Output that is refused ----------------------------------------------------------------------------------

const SCRIPT_BEARING = draftWithLine('Type "ada@example.test" into label "Email"', 'Type "<script>alert(document.cookie)</script>" into label "Email"').text;
// Far longer than any plan the project allows, yet under the 1 MiB reply limit once sent as JSON.
const OVER_LONG = `${GOLDEN_DRAFT}${'Go to /signup\n'.repeat(60_000)}`;

const REFUSED_REPLIES: readonly { readonly name: string; readonly reply: (wire: WireFormat) => JsonRecord }[] = [
  { name: 'a reply with no text, only a tool call', reply: replyWithoutText },
  { name: 'a reply whose text is a number', reply: (wire) => replyWithContent(wire, 42) },
  { name: 'a reply whose text holds a script tag', reply: (wire) => replyWithContent(wire, SCRIPT_BEARING) },
  { name: 'a reply whose text is over-long', reply: (wire) => replyWithContent(wire, OVER_LONG) },
];

for (const wire of WIRE_FORMATS) {
  for (const refused of REFUSED_REPLIES) {
    test(`${wire}: ${refused.name} writes no draft and reports plan-rejected`, { criterion: 'AC-SPEC-28-12' }, async () => {
      await withPlannedRun(customerKeySetup(wire, refused.reply(wire)), (run) => {
        assert.equal(run.planner.received.length, 1, 'the planner was not called, so the reply was never judged');
        assert.equal(run.workspace.exists(DRAFT_PATH), false, 'a draft was written');
        assert.deepEqual(outputErrorCodes(run), ['plan-rejected']);
        assert.equal(run.output?.['ok'], false);
        assert.notEqual(run.outcome.exitCode, 0);
      });
    });
  }

  test(`${wire}: counter-example: the recorded reply is written as the draft`, { criterion: 'AC-SPEC-28-12' }, async () => {
    await withPlannedRun(customerKeySetup(wire, replyWithContent(wire, GOLDEN_DRAFT)), (run) => {
      assert.equal(run.workspace.read(DRAFT_PATH), GOLDEN_DRAFT);
      assert.deepEqual(outputErrorCodes(run), []);
    });
  });
}

test('the script-bearing text is echoed nowhere in what the command prints', { criterion: 'AC-SPEC-28-12' }, async () => {
  await withPlannedRun(customerKeySetup('openai-chat', replyWithContent('openai-chat', SCRIPT_BEARING)), (run) => {
    for (const text of [run.outcome.stdout, run.outcome.stderr, run.printed]) {
      assert.equal(text.includes('document.cookie'), false, text);
    }
  });
});
