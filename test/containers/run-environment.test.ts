// Inside the run container, no cloud, production or publishing credential is readable: not in the
// environment, which is built from an empty allow-list with nothing inherited from the host, and
// not in a file, because only packages, node_modules, .browsers and the run's inputs are mounted,
// read-only. The host's environment is seeded with fake GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and
// NPM_TOKEN values first, so a runner that let the host's environment through would be caught.
// The proxy settings and the mounted packages, which the run does need, are the counter-examples
// that show the inspection itself sees what is there.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SEEDED_CREDENTIALS, jsonInside, startIsolatedRun, type IsolatedRun } from './isolated-run.ts';

const TIMEOUT = 600_000;

// Names that hold credentials for clouds, registries, source hosts and CI providers.
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|SESSION|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^GCLOUD_|^NPM_|^GH_|^GITHUB_|^ACTIONS_|^DOCKER_|^KUBE/i;

// Where credentials live on disk, relative to a home folder.
const HOME_CREDENTIAL_FILES = [
  '.aws/credentials', '.aws/config', '.npmrc', '.git-credentials', '.config/gh/hosts.yml', '.docker/config.json', '.kube/config',
  '.azure/accessTokens.json', '.azure/msal_token_cache.json', '.config/gcloud/application_default_credentials.json',
  '.config/gcloud/credentials.db', '.ssh/id_rsa', '.ssh/id_ed25519', '.netrc',
];

let run: IsolatedRun;
before(async () => { run = await startIsolatedRun(); }, { timeout: TIMEOUT });
after(async () => { await run?.stop(); }, { timeout: TIMEOUT });

type Environment = Readonly<Record<string, string>>;
const environmentInside = async (): Promise<Environment> =>
  await jsonInside(run.handle, 'console.log(JSON.stringify(process.env))') as Environment;

test('no seeded host credential is in the container\'s environment, by name or by value', { criterion: 'AC-SPEC-07-03', timeout: TIMEOUT }, async () => {
  const inside = await environmentInside();
  for (const [name, value] of Object.entries(SEEDED_CREDENTIALS)) {
    assert.ok(!Object.hasOwn(inside, name), `${name} reached the container`);
    assert.ok(!Object.values(inside).some((text) => text.includes(value)), `the value of ${name} reached the container`);
  }
});

test('no variable in the container\'s environment is named like a credential', { criterion: 'AC-SPEC-07-03', timeout: TIMEOUT }, async () => {
  const inside = await environmentInside();
  assert.deepEqual(Object.keys(inside).filter((name) => CREDENTIAL_NAME.test(name)), []);
});

test('counter-example: the inspection sees the environment the run does get, such as its proxy setting', { criterion: 'AC-SPEC-07-03', timeout: TIMEOUT }, async () => {
  const inside = await environmentInside();
  assert.ok(Object.keys(inside).length > 0, 'the environment inside is read');
  assert.ok(typeof inside['HTTP_PROXY'] === 'string' && inside['HTTP_PROXY'] !== '', JSON.stringify(Object.keys(inside)));
});

test('no credential file is readable in the home folder of the container\'s user or of root', { criterion: 'AC-SPEC-07-03', timeout: TIMEOUT }, async () => {
  const script = `
    const { accessSync, constants } = require('node:fs');
    const { homedir } = require('node:os');
    const { join } = require('node:path');
    const files = ${JSON.stringify(HOME_CREDENTIAL_FILES)};
    const readable = [];
    for (const home of [...new Set([homedir(), '/root', '/home/node'])]) {
      for (const file of files) {
        try { accessSync(join(home, file), constants.R_OK); readable.push(join(home, file)); } catch {}
      }
    }
    console.log(JSON.stringify(readable));`;
  assert.deepEqual(await jsonInside(run.handle, script), []);
});

test('the repository\'s .git folder is not mounted, while the packages the run needs are', { criterion: 'AC-SPEC-07-03', timeout: TIMEOUT }, async () => {
  const script = `
    const { existsSync, readFileSync } = require('node:fs');
    const mountPoints = readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').map((line) => line.split(' ')[4] ?? '');
    console.log(JSON.stringify({
      gitHere: existsSync('.git'),
      gitMounts: mountPoints.filter((point) => point === '.git' || point.endsWith('/.git')),
      packagesHere: existsSync('packages/runner/package.json'),
    }));`;
  assert.deepEqual(await jsonInside(run.handle, script), { gitHere: false, gitMounts: [], packagesHere: true });
});

test('neither the Docker socket nor a secrets folder is reachable from inside', { criterion: 'AC-SPEC-07-03', timeout: TIMEOUT }, async () => {
  const script = `
    const { existsSync } = require('node:fs');
    console.log(JSON.stringify(['/var/run/docker.sock', '/run/docker.sock', '/run/secrets'].filter((path) => existsSync(path))));`;
  assert.deepEqual(await jsonInside(run.handle, script), []);
});
