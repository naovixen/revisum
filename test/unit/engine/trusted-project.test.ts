// Trusted files are trusted by where they come from: core reads project.json, approvers.json and
// the code-owners file from the protected branch. A copy that exists only on another branch is
// refused, and an edit made by the change under test is ignored in favour of the protected
// version, raised as a changed-with-code review item naming the file, and recorded as a
// trusted.changed-with-code event. So an agent cannot widen its own origins, approvers or code
// owners.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '@revisum/engine';
import {
  APPROVERS_PATH, CODE_OWNERS_PATH, PLAN_PATH, PROJECT_PATH, approversOf, assertRefused, eventsOfKind, loadForChange,
  memoryEventSink, withRepository, type FixtureRepository,
} from './approval-repositories.ts';

const PRODUCTION_ORIGIN = 'https://shop.example.com';
const SMUGGLED_SECRET = 'PRODUCTION_DATABASE_URL';
const APPLICATION_CODE = 'src/signup.ts';

// The change under test's version of project.json: one more origin, one more secret.
const widenedProject = (fixture: FixtureRepository): unknown => {
  const project = structuredClone(fixture.protectedFiles[PROJECT_PATH]) as { origins: string[]; secretNames: string[] };
  project.origins.push(PRODUCTION_ORIGIN);
  project.secretNames.push(SMUGGLED_SECRET);
  return project;
};

const editsProjectWithCode = (fixture: FixtureRepository): void => {
  fixture.workingCopy[PROJECT_PATH] = widenedProject(fixture);
  fixture.workingCopy[APPLICATION_CODE] = 'export const signUp = () => fetch("/api/sign-up");\n';
};

// ---- project.json from another branch -----------------------------------------------------------

test('a project.json that exists only off the protected branch is refused as untrusted-source', { criterion: 'AC-SPEC-02-01' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH], memoryEventSink());
    assert.deepEqual(loaded, { ok: false, error: { code: 'untrusted-source', path: PROJECT_PATH } });
  }, (fixture) => {
    // The file is in the change's working copy, but the protected branch has none.
    fixture.workingCopy[PROJECT_PATH] = fixture.protectedFiles[PROJECT_PATH];
    delete fixture.protectedFiles[PROJECT_PATH];
  });
});

test('the same project.json on the protected branch is trusted, with protected-branch provenance', { criterion: 'AC-SPEC-02-01' }, async () => {
  // The counter-example: only where the file comes from differs from the refused case above.
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [], memoryEventSink());
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;
    assert.deepEqual(loaded.value.project.provenance, { kind: 'protected-branch', branch: 'main', commit: repository.fixture.protectedCommit });
  });
});

// ---- A trusted file edited together with application code ---------------------------------------

test('when the change edits project.json with application code, core uses the protected-branch version', { criterion: 'AC-SPEC-02-02' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE], memoryEventSink());
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;
    assert.deepEqual(loaded.value.project.secretNames, ['SIGNUP_PASSWORD'], 'the secret the change added was trusted');
    assert.ok(!JSON.stringify(loaded.value.project.origins).includes(PRODUCTION_ORIGIN), 'the origin the change added was trusted');
    assert.equal(loaded.value.project.provenance.kind, 'protected-branch');
  }, editsProjectWithCode);
});

test('a trusted file edited with application code raises one changed-with-code review item naming it', { criterion: 'AC-SPEC-02-02' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE], memoryEventSink());
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;
    assert.deepEqual(loaded.value.reviewItems, [{ code: 'changed-with-code', path: PROJECT_PATH }]);
  }, editsProjectWithCode);
});

test('each trusted file the change edits gets its own review item and trusted.changed-with-code event', { criterion: 'AC-SPEC-02-02' }, async () => {
  await withRepository('solo', async (repository) => {
    const events = memoryEventSink();
    const loaded = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE, PLAN_PATH], events);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;
    const named = loaded.value.reviewItems.map((item) => [item.code, item.path]).sort();
    assert.deepEqual(named, [['changed-with-code', PLAN_PATH], ['changed-with-code', PROJECT_PATH]]);
    assert.equal(eventsOfKind(events, 'trusted.changed-with-code').length, 2, JSON.stringify(events.recorded));
    assert.equal(events.recorded.length, 2, 'the loader appended events other than trusted.changed-with-code');
  }, editsProjectWithCode);
});

test('a change that edits only application code raises no review item and appends no event', { criterion: 'AC-SPEC-02-02' }, async () => {
  // The counter-example: the item and event come from the trusted file, not from any edit.
  await withRepository('solo', async (repository) => {
    const events = memoryEventSink();
    const loaded = await loadForChange(repository.versionControl(), [APPLICATION_CODE], events);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;
    assert.deepEqual(loaded.value.reviewItems, []);
    assert.deepEqual(events.recorded, []);
  });
});

test('the trusted project is the same whether or not the change edits project.json', { criterion: 'AC-SPEC-02-02' }, async () => {
  // Metamorphic: adding the change's edit must not change what core trusts.
  await withRepository('solo', async (repository) => {
    const untouched = await loadForChange(repository.versionControl(), [], memoryEventSink());
    const edited = await loadForChange(repository.versionControl(), [PROJECT_PATH, APPLICATION_CODE], memoryEventSink());
    assert.equal(untouched.ok && edited.ok, true, JSON.stringify({ untouched, edited }));
    if (!untouched.ok || !edited.ok) return;
    assert.equal(canonicalJson(edited.value.project), canonicalJson(untouched.value.project));
  }, editsProjectWithCode);
});

test('the same edit, once it is on the protected branch, is trusted', { criterion: 'AC-SPEC-02-02' }, async () => {
  // The counter-example that shows the tests above can fail: the protected version is what counts.
  await withRepository('solo', async (repository) => {
    const trusted = await repository.trustedProject();
    assert.ok(trusted.secretNames.some((name) => name === SMUGGLED_SECRET), 'the protected-branch version was not the one loaded');
  }, (fixture) => { fixture.protectedFiles[PROJECT_PATH] = widenedProject(fixture); });
});

// ---- approvers.json and the code-owners file are read from the protected branch -----------------

test('a code-owners file edited in the change does not make its new owner able to approve', { criterion: 'AC-SPEC-02-12' }, async () => {
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-linus'));
    assertRefused(repository, verified, 'not-code-owner');
  }, (fixture) => {
    // The change makes reviewer-linus the plans' owner; the protected branch does not.
    fixture.workingCopy[CODE_OWNERS_PATH] = `${String(fixture.protectedFiles[CODE_OWNERS_PATH])}/plans/ @reviewer-linus\n`;
    fixture.pullRequests['12']?.changedFiles.push({ path: CODE_OWNERS_PATH, authors: ['dev-ada'] });
  });
});

test('the same code-owners line on the protected branch does let that owner approve', { criterion: 'AC-SPEC-02-12' }, async () => {
  // The counter-example: the edit itself is valid, so the refusal above comes from where it was read.
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-linus'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => {
    fixture.protectedFiles[CODE_OWNERS_PATH] = `${String(fixture.protectedFiles[CODE_OWNERS_PATH])}/plans/ @reviewer-linus\n`;
  });
});

test('an approvers.json edited in the change does not make its new maintainer able to approve', { criterion: 'AC-SPEC-02-12' }, async () => {
  await withRepository('solo', async (repository) => {
    const proof = repository.lockdownProof({ commit: 'commit-agent-merge', mergedBy: 'agent-account' });
    assertRefused(repository, await repository.verify(repository.subject('plan'), proof), 'not-maintainer');
  }, (fixture) => {
    // The change names the agent's account as maintainer; that account then lands a commit on main.
    const edited = structuredClone(approversOf(fixture));
    if (edited.agentLockdown !== undefined) edited.agentLockdown.maintainer = 'agent-account';
    fixture.workingCopy[APPROVERS_PATH] = edited;
    fixture.landings.push({ commit: 'commit-agent-merge', branch: 'main', login: 'agent-account', type: 'user', at: '2026-10-25T09:00:00Z' });
  });
});

test('the same maintainer, once named in approvers.json on the protected branch, can approve', { criterion: 'AC-SPEC-02-12' }, async () => {
  await withRepository('solo', async (repository) => {
    const proof = repository.lockdownProof({ commit: 'commit-agent-merge', mergedBy: 'agent-account' });
    const verified = await repository.verify(repository.subject('plan'), proof);
    assert.equal(verified.ok, true, JSON.stringify(verified));
  }, (fixture) => {
    const lockdown = approversOf(fixture).agentLockdown;
    if (lockdown !== undefined) lockdown.maintainer = 'agent-account';
    fixture.landings.push({ commit: 'commit-agent-merge', branch: 'main', login: 'agent-account', type: 'user', at: '2026-10-25T09:00:00Z' });
  });
});

test('the verifier reads the code-owners file from the protected branch through the port', { criterion: 'AC-SPEC-02-12' }, async () => {
  await withRepository('team', async (repository) => {
    await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace'));
    const reads = repository.calls.filter((call) => call.startsWith('protectedFile '));
    assert.ok(reads.some((call) => call.endsWith(CODE_OWNERS_PATH)), `the code-owners file was not read from the protected branch: ${reads.join(', ')}`);
  });
});
