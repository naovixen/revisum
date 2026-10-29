// Shared setup for runSuite's tests: a fake workload runner that plays a suite's part, a checkout
// holding the suite's files, and the call that runs a declared suite end to end.
//
// runSuite(project, suiteName, ports) in cli joins engine and runner: it picks the declared suite,
// builds its arguments and environment, runs it through the workload runner, decodes the report
// it wrote and builds the result and manifest. The spec names runSuite, WorkloadRunner and
// WorkloadRequest. The shapes it leaves open are settled here only:
//   - the ports are { workload, secrets, checkout, outputDirectory }: the workload runner, the
//     secret store the declared secrets resolve through, the host folder of the repository under
//     test (the suite files are hashed from it) and the host folder Revisum owns for the suite's
//     output, which the workload runner mounts;
//   - runSuite resolves to the RunResult; a refused run has state 'Refused' and its refusal code;
//   - the suite writes its JSON report at the top of the output directory, under the file name
//     that PLAYWRIGHT_JSON_OUTPUT_NAME gives (that variable names the path inside the container);
//   - the workload runner fails with the bare WorkloadErrorCode, and WorkloadOutcome's stdout and
//     stderr are each { bytes, truncated }.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { runSuite } from '@revisum/cli';
import {
  failure, isSecret, success,
  type EgressEvent, type WorkloadErrorCode, type WorkloadOutcome, type WorkloadRequest, type WorkloadRunner,
} from '@revisum/contracts';
import { environmentSecretStore, type Project, type RunResult } from '@revisum/engine';
import {
  DECLARED_SECRET, SUITE_NAME, evidenceModeInput, parsedProject, projectFileWithEvidence, recordedReport, specPath, suiteInput, withoutSpec,
  type JsonRecord,
} from '../engine/evidence-examples.ts';
import { withValue } from '../engine/plan-examples.ts';

export { DECLARED_SECRET, SUITE_NAME };

// ---- The suite's part ---------------------------------------------------------------------------

export type SuiteBehaviour = {
  // The JSON report the suite writes; undefined writes none, as a suite stopped part way does.
  readonly report?: unknown;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly egressEvents?: readonly EgressEvent[];
  // The workload runner refuses every request with this code.
  readonly refusal?: WorkloadErrorCode;
};

export type FakeWorkloadRunner = WorkloadRunner & { readonly requests: readonly WorkloadRequest[] };

export const REPORT_VARIABLE = 'PLAYWRIGHT_JSON_OUTPUT_NAME';

// The text value of a variable in a request's environment, or undefined.
export function variable(request: WorkloadRequest, name: string): string | undefined {
  const value = request.environment.find((entry) => entry.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

// The request that runs the suite itself, as against its setup command: the one told where to
// write its JSON report.
export const isSuiteRequest = (request: WorkloadRequest): boolean => variable(request, REPORT_VARIABLE) !== undefined;

const captured = (text: string) => ({ bytes: new Uint8Array(Buffer.from(text, 'utf8')), truncated: false });

export function fakeWorkloadRunner(behaviour: SuiteBehaviour = {}): FakeWorkloadRunner {
  const requests: WorkloadRequest[] = [];
  return {
    requests,
    async run(request) {
      requests.push(request);
      if (behaviour.refusal !== undefined) return failure(behaviour.refusal);
      if (!isSuiteRequest(request)) {
        const setup: WorkloadOutcome = { exitCode: 0, timedOut: false, egressEvents: [], stdout: captured(''), stderr: captured('') };
        return success(setup);
      }
      const reportPath = variable(request, REPORT_VARIABLE) ?? '';
      if (behaviour.report !== undefined) {
        mkdirSync(request.outputDirectory, { recursive: true });
        writeFileSync(join(request.outputDirectory, posix.basename(reportPath)), JSON.stringify(behaviour.report));
      }
      const outcome: WorkloadOutcome = {
        exitCode: behaviour.exitCode ?? 0, timedOut: behaviour.timedOut ?? false, egressEvents: behaviour.egressEvents ?? [],
        stdout: captured(behaviour.stdout ?? ''), stderr: captured(behaviour.stderr ?? ''),
      };
      return success(outcome);
    },
  };
}

export function suiteRequestOf(runner: FakeWorkloadRunner): WorkloadRequest {
  const request = runner.requests.find(isSuiteRequest);
  assert.ok(request !== undefined, `the suite was never run: ${runner.requests.map((each) => JSON.stringify(each.argv)).join(', ')}`);
  return request;
}

// True when a request's environment value is an opaque Secret, not its text.
export const holdsSecretObject = (request: WorkloadRequest, name: string): boolean =>
  isSecret(request.environment.find((entry) => entry.name === name)?.value);

// ---- The checkout ----------------------------------------------------------------------------------

// The suite's files, under the paths the shared suite declaration names, and one application file
// outside them.
export const SUITE_FILES: Readonly<Record<string, string>> = {
  'apps/web/e2e/checkout.spec.ts': "import { test, expect } from '@playwright/test';\ntest('adds an item to the cart', async ({ page }) => {\n  await page.goto('/');\n});\n",
  'apps/web/e2e/helpers/cart.ts': 'export const emptyCart = () => [];\n',
  'apps/web/playwright.config.ts': "export default { testDir: 'e2e' };\n",
};
export const APPLICATION_FILE = 'apps/web/src/app.ts';

export function suiteCheckout(files: Readonly<Record<string, string>> = SUITE_FILES): string {
  const root = mkdtempSync(join(tmpdir(), 'suite-checkout-'));
  for (const [path, text] of Object.entries({ ...files, [APPLICATION_FILE]: 'export const app = 1;\n' })) {
    mkdirSync(join(root, posix.dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

export const outputFolder = (): string => mkdtempSync(join(tmpdir(), 'suite-output-'));

// ---- Running a suite -----------------------------------------------------------------------------------

export const evidenceProject = (fields: JsonRecord = {}): Project => parsedProject(projectFileWithEvidence(evidenceModeInput([suiteInput(fields)])));

export type SuiteRunOptions = {
  readonly project?: Project;
  readonly suiteName?: string;
  readonly behaviour?: SuiteBehaviour;
  readonly checkout?: string;
  // The declared secret's value in the secret store.
  readonly secretValue?: string;
};

export type SuiteRun = { readonly result: RunResult; readonly runner: FakeWorkloadRunner; readonly outputDirectory: string };

export async function runDeclaredSuite(options: SuiteRunOptions = {}): Promise<SuiteRun> {
  const runner = fakeWorkloadRunner(options.behaviour ?? { report: recordedReport('passing-with-criteria'), exitCode: 0 });
  const outputDirectory = outputFolder();
  const result = await runSuite(options.project ?? evidenceProject(), options.suiteName ?? SUITE_NAME, {
    workload: runner,
    secrets: environmentSecretStore({ [DECLARED_SECRET]: options.secretValue ?? 'shop-api-token-for-suite-runs-0042' }),
    checkout: options.checkout ?? suiteCheckout(),
    outputDirectory,
  });
  return { result, runner, outputDirectory };
}

// ---- Reports ---------------------------------------------------------------------------------------------

const FAILED_SPEC = 1;

// The each-outcome report cut down to its passing test and its failing one, whose error message
// is `message`. Playwright exits with 1 for it.
export function reportWithFailure(message: string): JsonRecord {
  const base = withoutSpec(withoutSpec(withoutSpec(recordedReport('each-outcome'), 4), 3), 2);
  return withValue(base, [...specPath(FAILED_SPEC), 'tests', 0, 'results', 0, 'errors', 0, 'message'], message);
}

// The passing report with one test that never got a result: a test the suite had not finished.
export function reportWithUnfinishedTest(): JsonRecord {
  return withValue(recordedReport('passing-with-criteria'), [...specPath(0), 'tests', 1, 'results'], []);
}

export const carriesCode = (value: unknown, code: string): boolean => JSON.stringify(value).includes(JSON.stringify(code));
