// The runner's product name comes from PRODUCT, so a rename stays a one-line change. This reads the
// runner's source, without its comments, because the rule does not show in what the code does; the
// scan is also run on a sample that breaks the rule, so a scan that found nothing could not pass by
// accident. What the names lead to, the run's containers and image, is checked from the outside as
// well. Casts to branded types are left to tools/repo-rules/code/CheckBrandedCasts.ts, which lists readImageDigest
// as the owner of its brand; what that parser accepts is checked here.
// and CLAUDE.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PRODUCT } from '@revisum/contracts';
import { RUN_IMAGE_TAG, dockerRunner, readImageDigest } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../../support/repository/RepositoryRoot.ts';
import type { Token } from '../../../tools/repo-rules/naming/LintRepository.ts';
import { codeTokens, listSourceFiles } from '../../../tools/repo-rules/ListSourceFiles.ts';
import { fakeContainerEngine } from './support/FakeContainerEngine.ts';
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from './examples/DeclaredService.ts';
import { TokenKind } from '../../../tools/repo-rules/naming/LintRepository.ts';

const runnerSources = (): readonly { readonly path: string; readonly tokens: readonly Token[] }[] =>
  listSourceFiles(REPOSITORY_ROOT, ['packages/runner/src']).map((path) => ({ path, tokens: codeTokens(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) }));

// A package's import name is the one place the product name may be written: the packages are named that.
const isPackageName = (token: Token): boolean => token.kind === TokenKind.String && token.text.startsWith(`@${PRODUCT.name}/`);

const productNameUses = (tokens: readonly Token[]): readonly string[] =>
  tokens.filter((token) => (token.kind === TokenKind.Identifier || token.kind === TokenKind.String) && !isPackageName(token) && token.text.toLowerCase().includes(PRODUCT.name.toLowerCase()))
    .map((token) => token.text);

test('the runner\'s code never spells the product name, beyond its packages\' import names', () => {
  const sources = runnerSources();
  assert.ok(sources.length >= 10, `only ${sources.length} source files were read`);
  const found = sources.flatMap(({ path, tokens }) => productNameUses(tokens).map((text) => `${path}: ${text}`));
  assert.deepEqual(found, []);
});

test('counter-example: the product-name scan finds a name and a text that spell it, and passes a package import', () => {
  const sample = `import { x } from '@${PRODUCT.name}/contracts'; export const ${PRODUCT.name}Mounts = '${PRODUCT.name}-run';`;
  assert.deepEqual(productNameUses(codeTokens(sample)), [`${PRODUCT.name}Mounts`, `${PRODUCT.name}-run`]);
});

test('an image id read from Docker becomes a digest only when it is one', () => {
  assert.equal(readImageDigest(PINNED_IMAGE_ID), PINNED_IMAGE_ID);
  for (const text of ['', 'sha256:', `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`, `sha256:${'A'.repeat(64)}`, `sha1:${'a'.repeat(64)}`, `${PINNED_IMAGE_ID}\n`, `${RUN_IMAGE_TAG}:latest`]) {
    assert.equal(readImageDigest(text), null, JSON.stringify(text));
  }
});

test('a run\'s image tag, run id and containers are all named from PRODUCT', async () => {
  assert.ok(RUN_IMAGE_TAG.startsWith(PRODUCT.name), RUN_IMAGE_TAG);
  const engine = fakeContainerEngine({ localImageId: PINNED_IMAGE_ID, internalNetworks: true, probe: 'blocked' });
  const started = await dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT }).withRun(imageDigest(PINNED_IMAGE_ID), egressPolicy({ allowOrigins: [] }), (run) => {
    assert.ok(run.runId.startsWith(`${PRODUCT.name}-`), run.runId);
    assert.ok(engine.started.every((options) => options.name.startsWith(run.runId)), JSON.stringify(engine.started.map((options) => options.name)));
    return Promise.resolve();
  });
  assert.ok(started.ok, JSON.stringify(started));
});
