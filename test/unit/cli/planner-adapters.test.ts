// The planner adapters behind the draft command: Anthropic Messages and the OpenAI-compatible chat
// format. Each builds its request from the engine's fixed prompt and sends it through runner's
// service caller behind the command's own egress proxy, which allows only the planner's origin.
// The key, a secret reference, goes only in its wire format's header: x-api-key for Anthropic,
// "Authorization: Bearer" for the OpenAI-compatible format; a local endpoint may have none. A local
// endpoint off loopback is refused with planner-endpoint-not-loopback before any request, and a
// network, egress or status failure is planner-call-failed, echoing neither the body nor the key.
//
// The endpoint is read from the protected branch's project.json, never the working tree's, so a
// change cannot redirect the key. A customer-key endpoint must be https:; a local one may be http:.
//
// The planner here is a local fake that replays a recorded reply. A customer-key endpoint is
// declared on a made-up host that only the test's resolver knows, so a request that went round the
// proxy could not reach it, and is served over HTTPS with a test certificate the command is told
// to trust. The seeded key is fresh in every test and scanned for in every form.
// See docs/specs/SPEC-37-explore-to-draft.md and docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { echoesIn } from '../engine/secret-examples.ts';
import { closedPort, jsonAnswer, sizedAnswer, type Answer } from '../runner/local-service.ts';
import {
  DRAFT_PATH, GOLDEN_DRAFT, PLANNER_HOST, PLANNER_KEY_NAME, PUBLIC_ADDRESS, WIRE_FORMATS,
  customerKeyPlanner, draftWorkspace, everythingWritten, goldenRequest, headerValue, localPlanner, onlyRequest, outputErrorCodes, projectFile,
  promptTexts, replyWithContent, requestBody, runDraft, seededSecrets, startFakePlanner, withPromptsReplaced, withPlannedRun,
  type PlannedRun, type WireFormat,
} from './draft-command-examples.ts';

// The header each wire format carries the key in, and the one it must not use.
const KEY_HEADERS: { readonly [Wire in WireFormat]: { readonly name: string; readonly value: (key: string) => string; readonly unused: string } } = {
  'anthropic-messages': { name: 'x-api-key', value: (key) => key, unused: 'authorization' },
  'openai-chat': { name: 'authorization', value: (key) => `Bearer ${key}`, unused: 'x-api-key' },
};

const recordedSetup = (wire: WireFormat, plannerKey?: Readonly<Record<string, string>>) => ({
  planner: () => customerKeyPlanner(wire),
  answer: jsonAnswer(200, replyWithContent(wire, GOLDEN_DRAFT)),
  routed: true,
  ...(plannerKey === undefined ? {} : { secrets: plannerKey }),
});

const assertNoDraft = (run: PlannedRun): void => {
  assert.equal(run.workspace.exists(DRAFT_PATH), false, 'a draft was written');
};

// ---- Each wire format ----------------------------------------------------------------------------------

for (const wire of WIRE_FORMATS) {
  describe(`the ${wire} adapter`, () => {
    test('its request matches the golden method, path, headers and body', { criterion: 'AC-SPEC-37-13' }, async () => {
      const golden = goldenRequest(wire);
      await withPlannedRun(recordedSetup(wire), (run) => {
        const request = onlyRequest(run.planner);
        assert.equal(request.method, golden.method);
        assert.equal(request.path, golden.path);
        for (const [name, value] of Object.entries(golden.headers)) {
          assert.equal(headerValue(request, name)?.split(';')[0]?.trim(), value, `header ${name}`);
        }
        assert.deepEqual(withPromptsReplaced(requestBody(request)), golden.body);
      });
    });

    test('the key goes only in its own header, in its own scheme', { criterion: 'AC-SPEC-37-13' }, async () => {
      const secrets = seededSecrets();
      await withPlannedRun(recordedSetup(wire, secrets.variables), (run) => {
        const request = onlyRequest(run.planner);
        const header = KEY_HEADERS[wire];
        assert.equal(headerValue(request, header.name), header.value(secrets.plannerKey));
        assert.equal(headerValue(request, header.unused), undefined, `the key's other header, ${header.unused}, was sent`);
        assert.deepEqual(echoesIn(request.body, secrets.plannerKey), [], 'the key is in the body');
      });
    });

    test('the request goes through the egress proxy, to the address the proxy vetted', { criterion: 'AC-SPEC-37-13' }, async () => {
      await withPlannedRun(recordedSetup(wire), (run) => {
        const request = onlyRequest(run.planner);
        assert.ok(run.resolver.lookupsOf(PLANNER_HOST) >= 1, 'the proxy never resolved the planner host, so the request went round it');
        assert.deepEqual(run.planner.dialled, [{ address: PUBLIC_ADDRESS, port: 443 }]);
        assert.equal(headerValue(request, 'host'), PLANNER_HOST);
      });
    });

    test('the key appears in no output, log, error, event or file', { criterion: 'AC-SPEC-37-13' }, async () => {
      const secrets = seededSecrets();
      await withPlannedRun(recordedSetup(wire, secrets.variables), (run) => {
        assert.ok(run.workspace.exists(DRAFT_PATH), `the call did not succeed:\n${run.outcome.stdout}`);
        assert.deepEqual(echoesIn(everythingWritten(run), secrets.plannerKey), []);
        // Counter-example: the scan finds the key in what the planner received.
        assert.notDeepEqual(echoesIn(JSON.stringify(onlyRequest(run.planner).headers), secrets.plannerKey), []);
      });
    });

    test('a refusal that echoes the key in its body gives planner-call-failed, with neither the body nor the key', { criterion: 'AC-SPEC-37-13' }, async () => {
      const secrets = seededSecrets();
      const bodyMark = 'REFUSAL-BODY-MARK-2W8';
      const echoingRefusal: Answer = (received, response) => {
        const sentKey = headerValue(received, KEY_HEADERS[wire].name) ?? '';
        response.writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { type: 'authentication_error', message: `${bodyMark}: invalid key ${sentKey}` } }));
      };
      await withPlannedRun({ ...recordedSetup(wire, secrets.variables), answer: echoingRefusal }, (run) => {
        assert.deepEqual(outputErrorCodes(run), ['planner-call-failed']);
        const written = everythingWritten(run);
        assert.equal(written.includes(bodyMark), false, 'the response body was echoed');
        assert.deepEqual(echoesIn(written, secrets.plannerKey), [], 'the key was echoed');
        assertNoDraft(run);
      });
    });
  });
}

test('both wire formats carry the same prompt texts', { criterion: 'AC-SPEC-37-13' }, async () => {
  const prompts: (readonly string[])[] = [];
  for (const wire of WIRE_FORMATS) {
    await withPlannedRun(recordedSetup(wire), (run) => {
      prompts.push(promptTexts(requestBody(onlyRequest(run.planner))));
    });
  }
  assert.ok((prompts[0]?.length ?? 0) > 0, 'the first request holds no prompt text');
  assert.deepEqual(prompts[1], prompts[0]);
});

// ---- Where the endpoint comes from --------------------------------------------------------------------

test('a working-tree project.json that points the planner elsewhere is ignored: the key goes only to the protected endpoint', { criterion: 'AC-SPEC-37-13' }, async () => {
  const secrets = seededSecrets();
  const trusted = await startFakePlanner(jsonAnswer(200, replyWithContent('anthropic-messages', GOLDEN_DRAFT)), true);
  const redirected = await startFakePlanner(jsonAnswer(200, replyWithContent('openai-chat', GOLDEN_DRAFT)));
  // The change under test keeps the key but sends it to its own server, as a local planner.
  const workspace = draftWorkspace({
    planner: customerKeyPlanner('anthropic-messages'),
    workingTreeProject: projectFile({ ...localPlanner(redirected.origin), apiKey: { secretName: PLANNER_KEY_NAME } }),
  });
  try {
    const run = await runDraft({ workspace, routeTo: trusted, secrets: secrets.variables });
    assert.equal(redirected.connections(), 0, 'the working tree\'s planner was connected to');
    assert.deepEqual(redirected.received, []);
    const request = onlyRequest(trusted);
    assert.equal(headerValue(request, 'x-api-key'), secrets.plannerKey);
    assert.equal(workspace.read(DRAFT_PATH), GOLDEN_DRAFT);
    const printed = [run.outcome.stdout, run.outcome.stderr, run.printed, JSON.stringify(run.events.recorded), workspace.read(DRAFT_PATH)].join('\n');
    assert.deepEqual(echoesIn(printed, secrets.plannerKey), []);
  } finally {
    await trusted.close();
    await redirected.close();
    workspace.dispose();
  }
});

test('a customer-key endpoint over plain http is refused by the project parser and nothing is sent', { criterion: 'AC-SPEC-37-13' }, async () => {
  const secrets = seededSecrets();
  await withPlannedRun({ ...recordedSetup('openai-chat', secrets.variables), planner: () => customerKeyPlanner('openai-chat', `http://${PLANNER_HOST}`) }, (run) => {
    assert.deepEqual(outputErrorCodes(run), ['config-invalid']);
    assert.equal(run.planner.connections(), 0, 'the planner was connected to');
    assert.deepEqual(run.planner.dialled, []);
    assert.deepEqual(echoesIn(everythingWritten(run), secrets.plannerKey), []);
    assertNoDraft(run);
  });
});

// ---- Local endpoints -----------------------------------------------------------------------------------

test('a local planner on loopback is called with no credential header', { criterion: 'AC-SPEC-37-13' }, async () => {
  await withPlannedRun({ planner: (fake) => localPlanner(fake.origin), answer: jsonAnswer(200, replyWithContent('openai-chat', GOLDEN_DRAFT)), routed: false }, (run) => {
    const request = onlyRequest(run.planner);
    assert.equal(headerValue(request, 'authorization'), undefined);
    assert.equal(headerValue(request, 'x-api-key'), undefined);
    assert.equal(run.workspace.read(DRAFT_PATH), GOLDEN_DRAFT);
  });
});

const OFF_LOOPBACK_ORIGINS = ['http://192.168.1.20:11434', 'http://10.0.0.5:11434', `http://${PUBLIC_ADDRESS}:11434`, 'http://ollama.example.org:11434'];

for (const origin of OFF_LOOPBACK_ORIGINS) {
  test(`a local planner at ${origin} is refused with planner-endpoint-not-loopback before any request`, { criterion: 'AC-SPEC-37-13' }, async () => {
    await withPlannedRun({
      planner: () => localPlanner(origin), answer: jsonAnswer(200, replyWithContent('openai-chat', GOLDEN_DRAFT)), routed: true,
      names: { 'ollama.example.org': [PUBLIC_ADDRESS] },
    }, (run) => {
      assert.deepEqual(outputErrorCodes(run), ['planner-endpoint-not-loopback']);
      assert.deepEqual(run.planner.received, [], 'a request was sent');
      assert.deepEqual(run.planner.dialled, [], 'the proxy connected');
      assert.deepEqual(run.resolver.asked, [], 'the endpoint host was looked up');
      assertNoDraft(run);
    });
  });
}

test('counter-example: the same local planner on 127.0.0.1 is called', { criterion: 'AC-SPEC-37-13' }, async () => {
  await withPlannedRun({ planner: (fake) => localPlanner(fake.origin), answer: jsonAnswer(200, replyWithContent('openai-chat', GOLDEN_DRAFT)), routed: false }, (run) => {
    assert.deepEqual(outputErrorCodes(run), []);
    assert.equal(run.planner.received.length, 1);
  });
});

// ---- Failed calls --------------------------------------------------------------------------------------

test('a planner answering 500 gives planner-call-failed without its body', { criterion: 'AC-SPEC-37-13' }, async () => {
  const bodyMark = 'SERVER-ERROR-BODY-MARK-6J1';
  await withPlannedRun({ ...recordedSetup('openai-chat'), answer: jsonAnswer(500, { error: { message: `${bodyMark} overloaded` } }) }, (run) => {
    assert.deepEqual(outputErrorCodes(run), ['planner-call-failed']);
    assert.equal(everythingWritten(run).includes(bodyMark), false, 'the response body was echoed');
    assertNoDraft(run);
  });
});

test('a local planner that nothing listens on gives planner-call-failed', { criterion: 'AC-SPEC-37-13' }, async () => {
  const port = await closedPort();
  await withPlannedRun({ planner: () => localPlanner(`http://127.0.0.1:${port}`), answer: jsonAnswer(200, {}), routed: false }, (run) => {
    assert.deepEqual(outputErrorCodes(run), ['planner-call-failed']);
    assertNoDraft(run);
  });
});

test('a customer-key planner whose host resolves to a private address is blocked by the proxy: planner-call-failed', { criterion: 'AC-SPEC-37-13' }, async () => {
  await withPlannedRun({ ...recordedSetup('anthropic-messages'), names: { [PLANNER_HOST]: ['10.0.0.5'] } }, (run) => {
    assert.deepEqual(outputErrorCodes(run), ['planner-call-failed']);
    assert.deepEqual(run.planner.received, [], 'the blocked request reached the planner');
    assert.deepEqual(run.planner.dialled, [], 'the proxy connected to a private address');
    assertNoDraft(run);
  });
});

test('a reply over the 1 MiB limit gives planner-call-failed and writes no draft', { criterion: 'AC-SPEC-37-13' }, async () => {
  await withPlannedRun({ ...recordedSetup('openai-chat'), answer: sizedAnswer(1024 * 1024 + 512 * 1024) }, (run) => {
    assert.deepEqual(outputErrorCodes(run), ['planner-call-failed']);
    assertNoDraft(run);
  });
});
