// The optional signed route: `approve` signs the subject hash with a key registered under
// signingKeys in protected-branch approvers.json. Core rejects a key it does not know and a
// signature made without the user-presence flag. Checking a valid signature waits for customer
// demand, so until then no signature verifies at all.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import type { ApprovalProof } from '@revisum/engine';
import { approversOf, assertRefused, eventsOfKind, withRepository, type FixtureRepository } from './approval-repositories.ts';

const REGISTERED_KEY_ID = 'maintainer-mia-security-key';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// Registers the maintainer's public key in protected-branch approvers.json.
const withRegisteredKey = (fixture: FixtureRepository): void => {
  approversOf(fixture).signingKeys = [{ keyId: REGISTERED_KEY_ID, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
};

const signatureProof = (subjectHash: string, keyId: string, userPresent: boolean): ApprovalProof => ({
  kind: 'signature', keyId, signature: sign(null, Buffer.from(subjectHash, 'utf8'), privateKey).toString('base64'), flags: { userPresent },
});

test('a signature with a key that protected-branch approvers.json does not register returns unknown-key', { criterion: 'AC-SPEC-02-10' }, async () => {
  await withRepository('solo', async (repository) => {
    const subject = repository.subject('plan');
    assertRefused(repository, await repository.verify(subject, signatureProof(subject.hash, 'key-the-agent-made', true)), 'unknown-key');
  }, withRegisteredKey);
});

test('a signature from a registered key without the user-presence flag returns no-user-presence', { criterion: 'AC-SPEC-02-10' }, async () => {
  await withRepository('solo', async (repository) => {
    const subject = repository.subject('plan');
    assertRefused(repository, await repository.verify(subject, signatureProof(subject.hash, REGISTERED_KEY_ID, false)), 'no-user-presence');
  }, withRegisteredKey);
});

test('while the signed route is unbuilt, no signature verifies, not even a valid one from a registered, user-present key', { criterion: 'AC-SPEC-02-10' }, async () => {
  await withRepository('solo', async (repository) => {
    const subject = repository.subject('plan');
    const verified = await repository.verify(subject, signatureProof(subject.hash, REGISTERED_KEY_ID, true));
    assert.equal(verified.ok, false, 'a signature verified before the signed route was built');
    assert.equal(eventsOfKind(repository.events, 'plan.approved').length, 0);
  }, withRegisteredKey);
});
