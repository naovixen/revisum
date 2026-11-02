// Every field of the run manifest is fed by an input, and changing that input changes the manifest
// hash or a nonHermeticInputs entry. The cases are enumerated from the type: the table below is
// typed over every key of Required<RunManifest> (with SPEC-08's added fields), and the same over
// `versions`, `seeds` and `clock`, so a new field without a case fails to compile
// (manifest-perturbation-guarantees.ts shows it).
//
// Each case starts from a fully populated manifest: a 1.3 plan that fills a secret, names saved
// storage state, calls a declared service, runs a database command, uses a css locator and a page
// script, run with a driver that has a build port and with every pin. The fields only other kinds of
// run have (an evidence run's record, a browser mutant's rewrites) start from their own builders.
// Each case checks its own field changed, so a case that perturbs the wrong input fails.
// See docs/specs/SPEC-08-manifest-and-replay.md (AC-02).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildManifest, canonicalJson, evidenceManifest, manifestHash, sha256, type AdapterInfo, type RunManifest } from '@revisum/engine';
import { declaredCheckoutSuite } from './evidence-examples.ts';
import { TEST_SERVICE_SECRET_NAMES } from './plan-examples.ts';
import {
  ORIGIN, PINS, closedScenario, removeFakeExecutables, runScenario,
  type ManifestUnderTest, type RunPins, type Scenario,
} from './replay-examples.ts';
import { call, orderArguments } from './service-call-examples.ts';
import { fakeSecretOfLength, fakeSecretValue, fakeStorageState } from './secret-examples.ts';
import {
  CSS_CHECK, DATABASE_SECRET, OPEN_CART, SCRIPT_SOURCES, SEED_EDITOR, SEED_EDITOR_FILE, SEED_ORDERS, XPATH_CHECK, unsafePlan, unsafeProjectFile,
  type JsonRecord,
} from './unsafe-feature-steps.ts';

after(removeFakeExecutables);

// ---- The fully populated run ---------------------------------------------------------------------

const SAVED_STATE = 'SAVED_STATE';
const TOKEN = 'SHOP_API_TOKEN';

const populatedProjectFile = (fields: JsonRecord = {}): JsonRecord =>
  unsafeProjectFile(['css-locator', 'xpath-locator', 'page-script', 'database-command'], {
    secretNames: [...TEST_SERVICE_SECRET_NAMES, DATABASE_SECRET, SAVED_STATE], ...fields,
  });

const POPULATED_STEPS: readonly JsonRecord[] = [
  OPEN_CART,
  { type: 'fill', locator: { by: 'label', label: 'API token' }, value: { secretName: TOKEN } },
  call('createOrder', orderArguments(), { orderId: 'orderId' }),
  SEED_ORDERS,
  CSS_CHECK,
  SEED_EDITOR,
];
const populatedPlan = (steps: readonly JsonRecord[] = POPULATED_STEPS, title = 'Cart totals'): JsonRecord => {
  const plan = unsafePlan(steps, { storageState: { secretName: SAVED_STATE } });
  return { ...plan, meta: { featureId: 'CART-1', specReference: 'specs/cart.md#totals', title } };
};

const ENVIRONMENT: Readonly<Record<string, string>> = {
  [TOKEN]: fakeSecretValue(), [DATABASE_SECRET]: fakeSecretValue(), [SAVED_STATE]: fakeStorageState().json,
};

const POPULATED: Scenario = {
  ...closedScenario(populatedProjectFile(), populatedPlan()),
  environment: ENVIRONMENT,
  scriptSources: SCRIPT_SOURCES,
  executable: 'browser executable, build 156.0.8078.47',
  reportedBuildVersion: '156.0.8078.47',
  pins: PINS,
};

let populated: Promise<ManifestUnderTest> | undefined;
const populatedManifest = (): Promise<ManifestUnderTest> => {
  populated ??= runScenario(POPULATED).then((ran) => ran.manifest);
  return populated;
};

const withPins = (change: (pins: RunPins) => RunPins) => (scenario: Scenario): Scenario =>
  ({ ...scenario, pins: change(scenario.pins ?? PINS) });
const withVersion = (name: keyof RunPins['versions'], value: string | readonly string[]) =>
  withPins((pins) => ({ ...pins, versions: { ...pins.versions, [name]: value } }));

// ---- Perturbations ---------------------------------------------------------------------------------

// The manifest before and after one perturbation.
type Perturbation = () => Promise<{ readonly before: ManifestUnderTest; readonly after: ManifestUnderTest }>;

// Changes one input of the populated run.
const ofInput = (change: (scenario: Scenario) => Scenario): Perturbation => async () => ({
  before: await populatedManifest(),
  after: (await runScenario(change(POPULATED))).manifest,
});

// A field no run input feeds, such as the schema id the engine writes: the manifest itself changes.
const ofManifest = (change: (manifest: ManifestUnderTest) => ManifestUnderTest): Perturbation => async () => {
  const before = await populatedManifest();
  return { before, after: change(before) };
};

// A browser mutant's rewrites reach the manifest only through the isolated runner's proxy, which a
// unit run has not got, so this case starts from the manifest builder itself.
const ofRewrites: Perturbation = async () => {
  const base = await runScenario(POPULATED);
  const target = base.project.matrix[0] ?? assert.fail('no target');
  const adapter: AdapterInfo = { id: 'playwright', version: 'recording', protocol: 'none' };
  const inputs = {
    plan: base.plan, target, adapter, browser: { name: 'recording-browser', version: '1.0' }, seed: POPULATED.seed,
    fixedTimeMilliseconds: POPULATED.clockStartMilliseconds, fixtures: [], host: POPULATED.host,
  };
  return {
    before: buildManifest({ ...inputs, responseRewrites: [{ origin: 'http://127.0.0.1:4310', name: 'heading-changed' }] }),
    after: buildManifest({ ...inputs, responseRewrites: [{ origin: 'http://127.0.0.1:4310', name: 'status-flipped' }] }),
  };
};

// An evidence run's record starts from the evidence manifest; one byte of one suite file changes it.
const ofEvidence: Perturbation = async () => {
  const manifestWith = (testSource: string): RunManifest => evidenceManifest({
    suite: declaredCheckoutSuite(),
    suiteFiles: [{ path: 'apps/web/tests/checkout.spec.ts', bytes: new TextEncoder().encode(testSource) }],
    browsers: ['chromium'], host: POPULATED.host,
  });
  return { before: manifestWith('test("checkout", () => {});\n'), after: manifestWith('test("checkout", () => {}); \n') };
};

const PERTURBATIONS: { readonly [Field in keyof Required<ManifestUnderTest>]: Perturbation } = {
  schema: ofManifest((manifest) => ({ ...manifest, schema: 'revisum.run-manifest/v2' })),
  engineVersion: ofManifest((manifest) => ({ ...manifest, engineVersion: '0.2.0' })),
  planHash: ofInput((scenario) => ({ ...scenario, plan: populatedPlan(POPULATED_STEPS, 'Cart totals, renamed') })),
  target: ofInput((scenario) => ({
    ...scenario,
    projectFile: populatedProjectFile({
      matrix: [{
        id: 'playwright-chromium', adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
        locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'light', reducedMotion: 'reduce',
      }],
    }),
  })),
  adapter: ofInput((scenario) => ({ ...scenario, adapterVersion: 'recording-2' })),
  browser: ofInput((scenario) => ({ ...scenario, browserVersion: '2.0' })),
  seeds: ofInput((scenario) => ({ ...scenario, seed: scenario.seed + 1 })),
  clock: ofInput((scenario) => ({ ...scenario, clockStartMilliseconds: scenario.clockStartMilliseconds + 1000 })),
  fixtures: ofInput((scenario) => ({ ...scenario, fixtures: scenario.fixtures.map((file, index) => (index === 0 ? { ...file, text: `${file.text} ` } : file)) })),
  host: ofInput((scenario) => ({ ...scenario, host: { ...scenario.host, arch: 'other' } })),
  nonHermeticInputs: ofInput((scenario) => ({ ...scenario, cannotPin: ['randomness'] })),
  // A secret too short to search for is redacted by key only: same name, another mode.
  secrets: ofInput((scenario) => ({ ...scenario, environment: { ...scenario.environment, [TOKEN]: fakeSecretOfLength(4) } })),
  storageState: ofInput((scenario) => ({ ...scenario, environment: { ...scenario.environment, [SAVED_STATE]: fakeStorageState().json } })),
  unsafeFeatures: ofInput((scenario) => ({ ...scenario, plan: populatedPlan([...POPULATED_STEPS, XPATH_CHECK]) })),
  unsafeDeclarations: ofInput((scenario) => ({
    ...scenario, scriptSources: { ...scenario.scriptSources, [SEED_EDITOR_FILE]: `${SCRIPT_SOURCES[SEED_EDITOR_FILE] ?? ''} ` },
  })),
  responseRewrites: ofRewrites,
  evidence: ofEvidence,
  executableSha256: ofInput((scenario) => ({ ...scenario, executable: `${scenario.executable ?? ''}, patched` })),
  projectHash: ofInput((scenario) => ({ ...scenario, projectFile: populatedProjectFile({ origins: [ORIGIN, 'http://127.0.0.1:4999'] }) })),
  versions: ofInput(withVersion('core', '0.2.0')),
  redactor: ofInput(withPins((pins) => ({ ...pins, redactor: sha256('another pii pattern') }))),
  limits: ofInput((scenario) => ({ ...scenario, projectFile: { ...populatedProjectFile(), limits: { stepTimeoutMilliseconds: 3000 } } })),
  baselinesHash: ofInput(withPins((pins) => ({ ...pins, baselinesHash: sha256('[{"path":"baselines/cart.png"}]') }))),
  rulesetHash: ofInput(withPins((pins) => ({ ...pins, rulesetHash: sha256('another probe setting') }))),
  imageDigest: ofInput(withPins((pins) => ({ ...pins, imageDigest: `sha256:${'cd'.repeat(32)}` }))),
  fontsSha256: ofInput(withPins((pins) => ({ ...pins, fontsSha256: sha256('one more font') }))),
  commit: ofInput(withPins((pins) => ({ ...pins, commit: 'fedcba9876543210fedcba9876543210fedcba98' }))),
};

const VERSION_PERTURBATIONS: { readonly [Field in keyof Required<NonNullable<ManifestUnderTest['versions']>>]: Perturbation } = {
  core: ofInput(withVersion('core', '0.2.0')),
  act: ofInput(withVersion('act', 'act-rules-2026.11')),
  axe: ofInput(withVersion('axe', '4.12.0')),
  node: ofInput(withVersion('node', 'v24.20.0')),
  packs: ofInput(withVersion('packs', ['shop-pack@1.0.0'])),
};

const SEED_PERTURBATIONS: { readonly [Field in keyof Required<RunManifest['seeds']>]: Perturbation } = {
  random: ofInput((scenario) => ({ ...scenario, seed: scenario.seed + 1 })),
};

const CLOCK_PERTURBATIONS: { readonly [Field in keyof Required<RunManifest['clock']>]: Perturbation } = {
  fixedTimeMilliseconds: ofInput((scenario) => ({ ...scenario, clockStartMilliseconds: scenario.clockStartMilliseconds + 1 })),
};

// ---- The checks ----------------------------------------------------------------------------------------

const fieldText = (value: unknown): string => (value === undefined ? '(absent)' : canonicalJson(value));
const fieldOf = (manifest: object, path: readonly string[]): unknown =>
  path.reduce<unknown>((holder, key) => (typeof holder === 'object' && holder !== null ? Reflect.get(holder, key) : undefined), manifest);

async function assertPerturbationShows(path: readonly string[], perturbation: Perturbation): Promise<void> {
  const { before, after } = await perturbation();
  const name = path.join('.');
  assert.notEqual(fieldOf(before, path), undefined, `${name} is absent from the manifest the case starts from`);
  assert.notEqual(fieldText(fieldOf(after, path)), fieldText(fieldOf(before, path)), `the case for ${name} did not change ${name}`);
  const hashChanged = manifestHash(after) !== manifestHash(before);
  const nonHermeticChanged = canonicalJson(after.nonHermeticInputs) !== canonicalJson(before.nonHermeticInputs);
  assert.ok(hashChanged || nonHermeticChanged, `changing ${name} changed neither the manifest hash nor nonHermeticInputs`);
}

test('the fully populated run records every manifest field a plan run can have', { criterion: 'AC-SPEC-08-02' }, async () => {
  const manifest = await populatedManifest();
  const onlyOtherRuns = new Set(['responseRewrites', 'evidence']);
  const absent = Object.keys(PERTURBATIONS).filter((field) => !onlyOtherRuns.has(field) && !Object.hasOwn(manifest, field));
  assert.deepEqual(absent, [], `fields missing from the populated manifest: ${JSON.stringify(manifest)}`);
});

for (const [field, perturbation] of Object.entries(PERTURBATIONS)) {
  test(`perturbing the input of ${field} changes the manifest hash or nonHermeticInputs`, { criterion: 'AC-SPEC-08-02' }, async () => {
    await assertPerturbationShows([field], perturbation);
  });
}

for (const [field, perturbation] of Object.entries(VERSION_PERTURBATIONS)) {
  test(`perturbing the ${field} version changes the manifest hash`, { criterion: 'AC-SPEC-08-02' }, async () => {
    await assertPerturbationShows(['versions', field], perturbation);
  });
}

for (const [field, perturbation] of Object.entries(SEED_PERTURBATIONS)) {
  test(`perturbing the ${field} seed changes the manifest hash`, { criterion: 'AC-SPEC-08-02' }, async () => {
    await assertPerturbationShows(['seeds', field], perturbation);
  });
}

for (const [field, perturbation] of Object.entries(CLOCK_PERTURBATIONS)) {
  test(`perturbing the clock's ${field} changes the manifest hash`, { criterion: 'AC-SPEC-08-02' }, async () => {
    await assertPerturbationShows(['clock', field], perturbation);
  });
}

test('a host run, whose pins name no run image, lists run-image in nonHermeticInputs', { criterion: 'AC-SPEC-08-02' }, async () => {
  const { imageDigest: _none, ...hostPins } = PINS;
  const host = await runScenario({ ...POPULATED, pins: hostPins });
  const pinned = await populatedManifest();
  assert.ok(host.manifest.nonHermeticInputs.includes('run-image'), JSON.stringify(host.manifest.nonHermeticInputs));
  assert.equal(pinned.nonHermeticInputs.includes('run-image'), false, 'a run with an image digest lists run-image');
  assert.equal(Object.hasOwn(host.manifest, 'imageDigest'), false);
});

test('the project hash leaves out the evidence-mode and planner sections, which a plan run never reads', { criterion: 'AC-SPEC-08-02' }, async () => {
  const withPlanner = await runScenario({
    ...POPULATED,
    projectFile: populatedProjectFile({ planner: { kind: 'local', url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.1', wire: 'openai-chat' } }),
  });
  const manifest = await populatedManifest();
  assert.notEqual(manifest.projectHash, undefined, 'the populated run records no project hash');
  assert.equal(withPlanner.manifest.projectHash, manifest.projectHash);
});

test('counter-example: changing an input the manifest leaves out on purpose, the base URL\'s port, changes neither', { criterion: 'AC-SPEC-08-02' }, async () => {
  const before = await populatedManifest();
  // The manifest keeps the fixtures' content hashes, never the address they were served from.
  const after = (await runScenario({ ...POPULATED, baseUrl: 'http://127.0.0.1:4999' })).manifest;
  assert.equal(manifestHash(after), manifestHash(before));
  assert.deepEqual(after.nonHermeticInputs, before.nonHermeticInputs);
});

test('a run given no pins, on a driver with no build port, records none of the added fields, so committed manifest hashes stand', { criterion: 'AC-SPEC-08-02' }, async () => {
  const unpinned = await runScenario({ ...POPULATED, pins: null, executable: null });
  const pinnedOnly = ['versions', 'redactor', 'limits', 'baselinesHash', 'rulesetHash', 'executableSha256', 'imageDigest', 'fontsSha256', 'commit', 'projectHash'];
  assert.deepEqual(pinnedOnly.filter((field) => Object.hasOwn(unpinned.manifest, field)), []);
});
