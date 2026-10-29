// The run container's processes run as a non-root user under the pinned seccomp profile
// (.devcontainer/seccomp-chrome-sandbox.json), with every capability dropped and no way to gain
// privileges. The kernel's own view, /proc/<pid>/status, is read from inside, for the container's
// first process and for a process started through exec.
//
// Seccomp mode 2 shows that a filter is on, not which one. The pinned profile is Docker's default
// plus the namespace calls Chrome's sandbox needs, so creating a user namespace, which Docker's
// default profile refuses to a process without capabilities, tells the two apart.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { jsonInside, startIsolatedRun, type IsolatedRun } from './isolated-run.ts';

const TIMEOUT = 600_000;
const NO_CAPABILITIES = '0000000000000000';
// Seccomp's filter mode in /proc/<pid>/status: 0 off, 1 strict, 2 filter.
const SECCOMP_FILTER_MODE = '2';

let run: IsolatedRun;
before(async () => { run = await startIsolatedRun(); }, { timeout: TIMEOUT });
after(async () => { await run?.stop(); }, { timeout: TIMEOUT });

type ProcessStatus = { readonly uid: string; readonly seccomp: string; readonly capabilities: readonly string[]; readonly noNewPrivileges: string };

// The status fields of a process inside the container: its real, effective, saved and file-system
// user ids, its seccomp mode, its effective, permitted, inheritable, bounding and ambient
// capability sets, and its no-new-privileges flag.
async function statusOf(processId: 'self' | '1'): Promise<ProcessStatus> {
  const script = `
    const { readFileSync } = require('node:fs');
    const fields = Object.fromEntries(readFileSync('/proc/${processId}/status', 'utf8').split('\\n')
      .map((line) => line.split(':\\t')).filter((parts) => parts.length === 2).map(([name, value]) => [name, value.trim()]));
    console.log(JSON.stringify({
      uid: fields.Uid ?? '',
      seccomp: fields.Seccomp ?? '',
      capabilities: ['CapEff', 'CapPrm', 'CapInh', 'CapBnd', 'CapAmb'].map((name) => fields[name] ?? ''),
      noNewPrivileges: fields.NoNewPrivs ?? '',
    }));`;
  return await jsonInside(run.handle, script) as ProcessStatus;
}

for (const processId of ['self', '1'] as const) {
  const which = processId === '1' ? 'the container\'s first process' : 'a process started through exec';
  test(`${which} runs as a non-root user`, { criterion: 'AC-SPEC-07-04', timeout: TIMEOUT }, async () => {
    const status = await statusOf(processId);
    const ids = status.uid.split(/\s+/);
    assert.equal(ids.length, 4, status.uid);
    assert.ok(ids.every((id) => id !== '0'), `user ids: ${status.uid}`);
  });

  test(`${which} runs under a seccomp filter`, { criterion: 'AC-SPEC-07-04', timeout: TIMEOUT }, async () => {
    assert.equal((await statusOf(processId)).seccomp, SECCOMP_FILTER_MODE);
  });

  test(`${which} holds no capability and cannot gain privileges`, { criterion: 'AC-SPEC-07-04', timeout: TIMEOUT }, async () => {
    const status = await statusOf(processId);
    assert.deepEqual(status.capabilities, [NO_CAPABILITIES, NO_CAPABILITIES, NO_CAPABILITIES, NO_CAPABILITIES, NO_CAPABILITIES]);
    assert.equal(status.noNewPrivileges, '1');
  });
}

test('Node inside the container reports a non-zero user id', { criterion: 'AC-SPEC-07-04', timeout: TIMEOUT }, async () => {
  const ids = await jsonInside(run.handle, 'console.log(JSON.stringify([process.getuid(), process.geteuid(), process.getgid()]))');
  assert.ok(Array.isArray(ids) && ids.length === 3 && ids.every((id) => typeof id === 'number' && id !== 0), JSON.stringify(ids));
});

test('the seccomp profile is the pinned one: it lets an unprivileged process create a user namespace, as Chrome\'s sandbox needs', { criterion: 'AC-SPEC-07-04', timeout: TIMEOUT }, async () => {
  const outcome = await run.handle.exec(['unshare', '--user', '--map-root-user', 'true']);
  assert.equal(outcome.exitCode, 0, `creating a user namespace failed, as under Docker's default profile: ${outcome.stderr}`);
});
