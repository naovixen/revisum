// Runs a declared suite end to end: the one place engine and runner meet for evidence mode. It
// picks the suite from the trusted project, resolves its environment, runs its setup command and
// then the suite through the workload runner, reads the JSON report and traces the suite wrote
// into Revisum's output folder, and builds the result and its manifest. Every output of the suite
// is decoded in engine before anything uses it; the secrets stay opaque until the runner writes
// the container's environment. The `run --suite` command that calls this is SPEC-16's.
// See docs/specs/SPEC-35-evidence-mode.md.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  SUITE_REPORT_FILE, WORKLOAD_OUTPUT_PATH,
  declaredSuite, defaultRedactor, evidenceManifest, evidenceResult, isSuiteFile, parseSuiteReport, parseSuiteTrace, refusedSuiteResult,
  suiteArguments, suiteEnvironment, suiteRedactor, unreadSuiteResult,
  type EgressPolicy, type EvidenceContext, type EvidenceLimits, type EvidenceSuiteDeclaration, type HostInfo, type Project, type Redactor,
  type RunResult, type SecretStore, type SuiteDecodeError, type SuiteFile, type SuitePass, type SuiteReport, type SuiteTrace,
  type WorkloadErrorCode, type WorkloadRequest, type WorkloadRunner, type WorkloadVariable,
} from '@revisum/engine';
import { buildEgressPolicy } from '@revisum/runner';

export type SuiteRunPorts = {
  readonly workload: WorkloadRunner;
  // Where the suite's declared secrets resolve.
  readonly secrets: SecretStore;
  // The host folder of the repository under test. The suite's files are hashed from it.
  readonly checkout: string;
  // The host folder Revisum owns for the suite's output, which the workload runner mounts.
  readonly outputDirectory: string;
  // The personal-data redaction every kept text goes through, before the suite's secrets are
  // removed; defaultRedactor() when absent.
  readonly redactor?: Redactor;
  // Which pass this is (suitePasses); the gating pass when absent.
  readonly pass?: SuitePass;
};

const TRACE_ATTACHMENT = 'trace';
const host = (): HostInfo => ({ platform: process.platform, arch: process.arch });

// The suite may reach the project's own origins, never its production ones, and no service.
function suitePolicy(project: Project): EgressPolicy {
  const allowOrigins = project.origins.filter((origin) => !project.productionOrigins.includes(origin));
  const built = buildEgressPolicy({ allowOrigins, allowServices: [] });
  // With no response rewrites the builder has nothing to refuse.
  if (!built.ok) throw new Error('the suite egress policy was refused');
  return built.value;
}

// The folder a glob's files all lie under: its segments before the first one with a wildcard.
const globFolder = (glob: string): string => {
  const segments = glob.split('/');
  const wild = segments.findIndex((segment) => /[*?[{]/.test(segment));
  return (wild === -1 ? segments : segments.slice(0, wild)).join('/');
};

// Every file of the suite in the checkout, by repository-relative path. Links are not followed, so
// nothing outside the checkout is read, and .git is never entered.
function suiteFiles(checkout: string, suite: EvidenceSuiteDeclaration): readonly SuiteFile[] {
  const found = new Map<string, SuiteFile>();
  const visit = (relative: string): void => {
    const absolute = join(checkout, relative);
    if (!existsSync(absolute)) return;
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) return;
    if (entry.isFile()) {
      if (isSuiteFile(suite, relative) && !found.has(relative)) found.set(relative, { path: relative, bytes: new Uint8Array(readFileSync(absolute)) });
      return;
    }
    if (!entry.isDirectory()) return;
    for (const name of readdirSync(absolute)) {
      if (name !== '.git') visit(relative === '' ? name : posix.join(relative, name));
    }
  };
  for (const glob of suite.paths) visit(globFolder(glob));
  return [...found.values()];
}

type ReadReport = { readonly ok: true; readonly report: SuiteReport } | { readonly ok: false; readonly errors: readonly SuiteDecodeError[] };

// The report the suite wrote at the top of the output folder, decoded under the evidence limits.
function readReport(outputDirectory: string, limits: EvidenceLimits): ReadReport {
  const file = join(outputDirectory, SUITE_REPORT_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) return { ok: false, errors: [{ code: 'suite-report-missing', path: '$' }] };
  if (statSync(file).size > limits.maximumReportBytes) return { ok: false, errors: [{ code: 'too-large', path: '$' }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, errors: [{ code: 'suite-report-invalid', path: '$' }] };
  }
  const decoded = parseSuiteReport(parsed, limits, { outputDirectory: WORKLOAD_OUTPUT_PATH });
  return decoded.ok ? { ok: true, report: decoded.value } : { ok: false, errors: decoded.error };
}

// The traces the report attaches, each read from the output folder and decoded. A trace that is
// missing, too large or refused is left out: the test's finding then has no trace steps.
function readTraces(outputDirectory: string, report: SuiteReport, limits: EvidenceLimits): readonly SuiteTrace[] {
  const paths = new Set(report.tests.flatMap((test) => test.attachments
    .flatMap((attachment) => (attachment.name === TRACE_ATTACHMENT && attachment.path !== undefined ? [attachment.path] : []))));
  const traces: SuiteTrace[] = [];
  for (const path of paths) {
    // The decoder has checked each path stays inside the output folder.
    const file = join(outputDirectory, path);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).size > limits.maximumTraceBytes) continue;
    const decoded = parseSuiteTrace(new Uint8Array(readFileSync(file)), limits, path);
    if (decoded.ok) traces.push(decoded.value);
  }
  return traces;
}

const refusalFor = (code: WorkloadErrorCode) => ({ code });

export async function runSuite(project: Project, suiteName: string, ports: SuiteRunPorts): Promise<RunResult> {
  const chosen = declaredSuite(project, suiteName);
  if (!chosen.ok) return refusedSuiteResult(suiteName, chosen.error);
  const suite = chosen.value;
  const limits = project.evidenceMode?.limits;
  if (limits === undefined) return refusedSuiteResult(suiteName, { code: 'evidence-mode-disabled' });
  const environment = suiteEnvironment(suite, ports.secrets);
  if (!environment.ok) return refusedSuiteResult(suiteName, { code: 'secret-missing', secretName: environment.error });

  // The suite files are pinned before anything runs, so the manifest says what was run.
  const files = suiteFiles(ports.checkout, suite);
  const policy = suitePolicy(project);
  const request = (argv: readonly string[], variables: readonly WorkloadVariable[]): WorkloadRequest => ({
    image: suite.image, argv, workingDirectory: suite.workingDirectory, environment: variables, policy,
    timeoutMilliseconds: suite.timeoutMilliseconds, outputDirectory: ports.outputDirectory,
  });
  const redactor = suiteRedactor(ports.redactor ?? defaultRedactor(), environment.value.secrets);
  const context = (exitCode: number, timedOut: boolean, extra: Partial<EvidenceContext> = {}): EvidenceContext => ({
    suite, pass: ports.pass ?? 'gating', exitCode, redactor, timedOut, ...extra,
  });
  const manifestFor = (report: SuiteReport | null, traces: readonly SuiteTrace[]) => evidenceManifest({
    suite, suiteFiles: files, host: host(),
    playwrightVersion: report?.playwrightVersion ?? traces.find((trace) => trace.playwrightVersion !== undefined)?.playwrightVersion,
    browsers: traces.flatMap((trace) => (trace.browserName === undefined ? [] : [trace.browserName])),
  });

  if (suite.setupCommand !== undefined) {
    const setup = await ports.workload.run(request(suite.setupCommand, environment.value.variables));
    if (!setup.ok) return refusedSuiteResult(suiteName, refusalFor(setup.error));
    if (setup.value.timedOut || setup.value.exitCode !== 0) {
      return unreadSuiteResult(context(setup.value.exitCode, setup.value.timedOut, { manifest: manifestFor(null, []) }),
        setup.value.timedOut ? 'suite-timeout' : 'setup-failed');
    }
  }

  const built = suiteArguments(suite, WORKLOAD_OUTPUT_PATH);
  const variables: WorkloadVariable[] = [
    ...environment.value.variables,
    ...Object.entries(built.environment).map(([name, value]): WorkloadVariable => ({ name, value })),
  ];
  // The project parser refuses a declared variable of a name Revisum sets, such as the report's.
  const ran = await ports.workload.run(request(built.argv, variables));
  if (!ran.ok) return refusedSuiteResult(suiteName, refusalFor(ran.error));
  const { exitCode, timedOut, egressEvents } = ran.value;
  const blockedOrigins = egressEvents.filter((event) => event.decision === 'blocked').map((event) => event.origin);

  const read = readReport(ports.outputDirectory, limits);
  if (!read.ok) {
    return unreadSuiteResult(context(exitCode, timedOut, { manifest: manifestFor(null, []), blockedOrigins }),
      timedOut ? 'suite-timeout' : 'suite-report-unread', read.errors);
  }
  const traces = readTraces(ports.outputDirectory, read.report, limits);
  return evidenceResult(read.report, traces, [], context(exitCode, timedOut, { manifest: manifestFor(read.report, traces), blockedOrigins }));
}
