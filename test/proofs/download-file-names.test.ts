// The name a server gives a download is data, never a path. The fixture server sends five files
// whose Content-Disposition names are hostile: "../../etc/passwd", a parent path with a name only
// this test uses, an absolute path in the temporary folder, and the Windows device names "CON"
// and "NUL.txt". Each is downloaded and checked on the own CDP driver.
// Just before the run closes its session, the disk is searched for the file's marker: it is held
// by exactly one file, whose name the driver generated (not the server's name, not a device
// name), in a folder of its own. Once the run has closed, that file and its folder are gone, and
// no file anywhere holds the marker or carries the escaping name; the absolute path was never
// written and /etc/passwd, where there is one, is unchanged.
// A counter-example plants a file with the escaping name, to show the search finds one.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  CDP_TARGET, download, expectDownload, navigate, pageStatesHarness, role, type PageStatesHarness,
} from '../contract/page-states-support.ts';
import { downloadSearchRoots, filesHolding, filesNamed, isDeviceName } from '../support/stored-files.ts';

const TIMEOUT = 120_000;
const SYSTEM_PASSWORD_FILE = '/etc/passwd';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

const digestOf = (path: string): string | null => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
// The last part of a name, whichever separator the server used.
const lastPart = (name: string): string => name.split(/[\\/]/).pop() ?? name;
// Folders a "../../" name could reach from a download folder anywhere under the search roots.
const nearbyFolders = (): readonly string[] => [...new Set([
  tmpdir(), dirname(tmpdir()), dirname(dirname(tmpdir())), process.cwd(), dirname(process.cwd()), homedir(), join(homedir(), 'Downloads'),
])];
const escapingName = (): string => `revisum-escaped-${harness.nonce}`;

test('every hostile file is served under the name it claims, with a marker in its bytes', { criterion: 'AC-SPEC-31-07' }, () => {
  assert.deepEqual(harness.hostileFiles.map((file) => lastPart(file.fileName)), [
    'passwd', `${escapingName()}.txt`, `${escapingName()}-absolute.txt`, 'CON', 'NUL.txt',
  ]);
  for (const file of harness.hostileFiles) assert.ok(file.bytes.toString('utf8').includes(file.marker));
});

// The hostile names, in the order the harness serves them.
const HOSTILE_NAMES = [
  '"../../etc/passwd"', 'a parent path with a name only this test uses', 'an absolute path in the temporary folder',
  'the device name "CON"', 'the device name "NUL.txt"',
];

for (const [index, described] of HOSTILE_NAMES.entries()) {
  test(`a download the server names ${described} is stored under a generated name inside the run's download folder, and nothing is written outside it`, { criterion: 'AC-SPEC-31-07', timeout: TIMEOUT }, async () => {
    const file = harness.hostileFiles[index];
    assert.ok(file !== undefined);
    const passwordBefore = digestOf(SYSTEM_PASSWORD_FILE);
    const atClose: { stored: readonly string[] | null } = { stored: null };
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/downloads.html'),
      download('hostile-file', role('link', file.linkName)),
      expectDownload('hostile-file', { kind: 'contentContains', value: file.marker }, 'downloads.hostile-content-kept'),
      expectDownload('hostile-file', { kind: 'sizeAtLeast', value: file.bytes.length }, 'downloads.hostile-size-kept'),
    ], { beforeClose: async (_session, startedAt) => { atClose.stored = filesHolding(file.marker, startedAt); } });
    assert.equal(ran.result.state, 'Passed', `${file.kind}: ${JSON.stringify(ran.result.steps)}`);

    // While the session was open: one stored copy, under a name the driver chose, in its own folder.
    assert.equal(atClose.stored?.length, 1, `${file.kind}: one stored copy: ${JSON.stringify(atClose.stored)}`);
    const storedPath = atClose.stored?.[0] ?? '';
    const storedName = basename(storedPath);
    assert.notEqual(storedName.toLowerCase(), lastPart(file.fileName).toLowerCase(), `${file.kind}: stored under the server's name`);
    assert.ok(!isDeviceName(storedName), `${file.kind}: stored under a device name: ${storedName}`);
    assert.ok(!storedName.includes(harness.nonce), `${file.kind}: the stored name holds part of the server's name`);
    const storedFolder = dirname(storedPath);
    assert.ok(!downloadSearchRoots().includes(storedFolder), `${file.kind}: stored straight into ${storedFolder}, not a folder of the run's own`);

    // Once the run closed: the driver removed its folder, and no copy is left anywhere.
    assert.ok(!existsSync(storedPath), `${file.kind}: the stored file was removed`);
    assert.ok(!existsSync(storedFolder), `${file.kind}: the run's download folder was removed`);
    assert.deepEqual(filesHolding(file.marker, ran.startedAt), [], `${file.kind}: no copy of the file is left`);
    assert.deepEqual(filesNamed(escapingName(), ran.startedAt), [], `${file.kind}: no file carries the escaping name`);
    for (const folder of nearbyFolders()) {
      for (const name of [`${escapingName()}.txt`, `${escapingName()}-absolute.txt`]) assert.ok(!existsSync(join(folder, name)), `${file.kind}: ${join(folder, name)} was written`);
    }
    assert.ok(!existsSync(join(tmpdir(), `${escapingName()}-absolute.txt`)), `${file.kind}: the absolute path was written`);
    assert.equal(digestOf(SYSTEM_PASSWORD_FILE), passwordBefore, `${file.kind}: ${SYSTEM_PASSWORD_FILE} changed`);
  });
}

// Counter-example: a file with the escaping name written into the temporary folder is found by
// the same searches, so their empty answers above mean something.
test('counter-example: a planted file with the escaping name and a marker is found by both searches', { criterion: 'AC-SPEC-31-07' }, () => {
  const startedAt = Date.now();
  const planted = join(tmpdir(), `${escapingName()}-planted.txt`);
  const marker = `planted-marker-${harness.nonce}`;
  writeFileSync(planted, `${marker}\n`);
  try {
    assert.deepEqual(filesNamed(escapingName(), startedAt), [planted]);
    assert.deepEqual(filesHolding(marker, startedAt), [planted]);
  } finally {
    rmSync(planted, { force: true });
  }
});
