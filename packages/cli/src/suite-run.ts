// Runs a declared suite end to end: the one place engine and runner meet for evidence mode. It
// picks the suite from the trusted project, resolves its environment, runs its setup command and
// then the suite through the workload runner, reads the JSON report and traces the suite wrote
// into Revisum's output folder, and builds the result and its manifest. Every output of the suite
// is decoded in engine before anything uses it; the secrets stay opaque until the runner writes
// the container's environment. Any earlier report and traces are removed just before the suite runs,
// so what is read afterwards cannot be left from setup or an earlier run or pass, and every file read
// from the folder must really lie inside it. The `run --suite` command that calls this is not here.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import {
  EvidenceOutcomeCode, RECORD_UNREAD, SUITE_EVIDENCE_PATHS, SUITE_REPORT_FILE, WORKLOAD_OUTPUT_PATH,
  declaredSuite, defaultRedactor, evidenceManifest, evidenceResult, failure, isSuiteFile, mergeRefusedOrigins, parseSuiteReport, parseSuiteTrace, refusedSuiteResult,
  recordRead, success, suiteArguments, suiteEnvironment, suiteRedactor, unreadSuiteResult,
  type EgressEvent, type EgressPolicy, type EvidenceContext, type EvidenceLimits, type EvidenceRunManifest, type EvidenceSuiteDeclaration, type HostInfo, type Project, type Redactor,
  type RecordRead, type Result, type RunResult, type SecretStore, type SuiteDecodeError, type SuiteFile, type SuitePass, type SuiteReport, type SuiteTrace,
  type WorkloadErrorCode, type WorkloadOutcome, type WorkloadRequest, type WorkloadRunner, type WorkloadVariable,
} from '@revisum/engine';
import { buildEgressPolicy } from '@revisum/runner';

export type SuiteRunPorts = {
  readonly workload: WorkloadRunner;
  // Where the suite's declared secrets resolve.
  readonly secrets: SecretStore;
  // The host folder of the repository under test. The suite's files are hashed from it.
  readonly checkout: string;
  // The host folder Revisum owns for the suite's output, which the workload runner mounts. Each run
  // deletes any earlier report and traces in it.
  readonly outputDirectory: string;
  // The personal-data redaction every kept text goes through, before the suite's secrets are
  // removed; defaultRedactor() when absent.
  readonly redactor?: Redactor;
  // Which pass this is (suitePasses). Required, because a caller that left it out must not get the
  // pass that may open the merge gate.
  readonly pass: SuitePass;
};

const TRACE_ATTACHMENT = 'trace';
// A suite stopped at its timeout has no exit code, and the published result's field is a number: its
// outcome code says why, and nothing compares this one with the outcomes.
const STOPPED_SUITE_EXIT_CODE = -1;
const exitCodeOf = (outcome: WorkloadOutcome): number => (outcome.kind === 'exited' ? outcome.exitCode : STOPPED_SUITE_EXIT_CODE);
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

const isInsideFolder = (folder: string, path: string): boolean => {
  const fromFolder = relative(folder, path);
  return fromFolder !== '..' && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder);
};

// Makes sure the output folder exists. Refused when it holds the checkout: the team's container could
// then write to the read-only checkout, and a caller's mistake could lose files in it.
function readyOutputFolder(outputDirectory: string, checkout: string): Result<void, WorkloadErrorCode> {
  try {
    mkdirSync(outputDirectory, { recursive: true });
    return isInsideFolder(realpathSync.native(outputDirectory), realpathSync.native(checkout)) ? failure('workload-start-failed') : success(undefined);
  } catch {
    return failure('workload-start-failed');
  }
}

// Why the host's user could not remove the path, or null when it could. Links are removed, never followed.
function hostFailureRemoving(path: string): string | null {
  try {
    rmSync(path, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// A container's user may be another uid than the host's, and then only that user can empty a folder
// the container made, so it gets to try what the host could not. Whatever removed them, the host's own
// look decides: a leftover could not be told from what this run writes, so one that is still there, or
// that can't be looked for, refuses the run.
async function removeEarlierEvidence(workload: WorkloadRunner, image: string, outputDirectory: string): Promise<Result<void, WorkloadErrorCode>> {
  const hostFailures = SUITE_EVIDENCE_PATHS.flatMap((path) => {
    const hostFailure = hostFailureRemoving(join(outputDirectory, path));
    return hostFailure === null ? [] : [{ path, hostFailure }];
  });
  const [firstFailure] = hostFailures;
  if (firstFailure !== undefined) {
    await workload.removeFromOutput?.({ image, outputDirectory, paths: hostFailures.map(({ path }) => path), hostFailure: firstFailure.hostFailure });
  }
  try {
    const hasAllGone = SUITE_EVIDENCE_PATHS.every((path) => lstatSync(join(outputDirectory, path), { throwIfNoEntry: false }) === undefined);
    return hasAllGone ? success(undefined) : failure('workload-start-failed');
  } catch {
    return failure('workload-start-failed');
  }
}

// What the egress proxy refused while a workload ran, or that its record could not be read back whole.
const egressOf = (outcome: WorkloadOutcome): RecordRead<readonly string[]> =>
  outcome.egressRecordUnread === true ? RECORD_UNREAD : recordRead(blockedOriginsOf(outcome.egressEvents));

// Each refusal once. Only the browser's own records carry a form the browser saw.
function blockedOriginsOf(events: readonly EgressEvent[]): readonly string[] {
  const blocked = events.filter((event) => event.decision === 'blocked');
  const isFromBrowser = (event: EgressEvent): boolean => event.channel !== 'unattributed' && event.channel !== 'process';
  return mergeRefusedOrigins(
    blocked.filter(isFromBrowser).map((event) => event.origin),
    blocked.filter((event) => !isFromBrowser(event)).map((event) => event.origin),
  );
}

type OutputFileProblem = 'missing' | 'refused';

// Where a file named inside the output folder really is, with every link on its path followed. The
// suite controls the folder and Revisum reads with host rights, so a link must not lead it elsewhere.
function outputFile(outputDirectory: string, path: string): Result<string, OutputFileProblem> {
  let real: string;
  let folder: string;
  try {
    folder = realpathSync.native(outputDirectory);
    real = realpathSync.native(join(outputDirectory, path));
  } catch {
    return failure('missing');
  }
  return isInsideFolder(folder, real) ? success(real) : failure('refused');
}

type ReadReport = { readonly ok: true; readonly report: SuiteReport } | { readonly ok: false; readonly errors: readonly SuiteDecodeError[] };

// The report the suite wrote at the top of the output folder, decoded under the evidence limits.
function readReport(outputDirectory: string, limits: EvidenceLimits): ReadReport {
  const file = outputFile(outputDirectory, SUITE_REPORT_FILE);
  if (!file.ok) {
    return { ok: false, errors: [{ code: file.error === 'refused' ? 'suite-report-invalid' : 'suite-report-missing', path: '$' }] };
  }
  if (!statSync(file.value).isFile()) {
    return { ok: false, errors: [{ code: 'suite-report-missing', path: '$' }] };
  }
  if (statSync(file.value).size > limits.maximumReportBytes) {
    return { ok: false, errors: [{ code: 'too-large', path: '$' }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file.value, 'utf8'));
  } catch {
    return { ok: false, errors: [{ code: 'suite-report-invalid', path: '$' }] };
  }
  const decoded = parseSuiteReport(parsed, limits, { outputDirectory: WORKLOAD_OUTPUT_PATH });
  return decoded.ok ? { ok: true, report: decoded.value } : { ok: false, errors: decoded.error };
}

type ReadTraces = { readonly traces: readonly SuiteTrace[]; readonly decodeErrors: readonly SuiteDecodeError[] };

// One trace's bytes decoded, or why they could not be. No error holds the report's text for the
// path, which the suite wrote.
function readTrace(outputDirectory: string, path: string, limits: EvidenceLimits): Result<SuiteTrace, SuiteDecodeError> {
  const unreadable = failure<SuiteDecodeError>({ code: 'trace-invalid', path: '$' });
  // The decoder has checked each path stays inside the output folder as written; this follows links.
  const file = outputFile(outputDirectory, path);
  if (!file.ok) {
    return unreadable;
  }
  try {
    const found = statSync(file.value);
    if (!found.isFile()) {
      return unreadable;
    }
    if (found.size > limits.maximumTraceBytes) {
      return failure({ code: 'too-large', path: '$' });
    }
    return parseSuiteTrace(new Uint8Array(readFileSync(file.value)), limits, path);
  } catch {
    return unreadable;
  }
}

// The traces the report attaches, each read from the output folder and decoded. One that is missing,
// too large or refused leaves its test's finding with no trace steps, and is listed by its place
// among the report's traces.
function readTraces(outputDirectory: string, report: SuiteReport, limits: EvidenceLimits): ReadTraces {
  const paths = new Set(report.tests.flatMap((test) => test.attachments
    .flatMap((attachment) => (attachment.name === TRACE_ATTACHMENT && attachment.path !== undefined ? [attachment.path] : []))));
  const traces: SuiteTrace[] = [];
  const decodeErrors: SuiteDecodeError[] = [];
  for (const [index, path] of [...paths].entries()) {
    const decoded = readTrace(outputDirectory, path, limits);
    if (decoded.ok) {
      traces.push(decoded.value);
    } else {
      decodeErrors.push({ code: decoded.error.code, path: `$.traces[${index}]${decoded.error.path.slice(1)}` });
    }
  }
  return { traces, decodeErrors };
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
  const context = <Egress extends RecordRead<readonly string[]>>(
    exitCode: number, timedOut: boolean, manifest: EvidenceRunManifest, egress: Egress, traceDecodeErrors?: readonly SuiteDecodeError[],
  ): EvidenceContext & { readonly egress: Egress } => ({
    suite, pass: ports.pass, exitCode, redactor, timedOut, manifest, egress, ...(traceDecodeErrors === undefined ? {} : { traceDecodeErrors }),
  });
  const manifestFor = (report: SuiteReport | null, traces: readonly SuiteTrace[]) => evidenceManifest({
    suite, suiteFiles: files, host: host(),
    playwrightVersion: report?.playwrightVersion ?? traces.find((trace) => trace.playwrightVersion !== undefined)?.playwrightVersion,
    browsers: traces.flatMap((trace) => (trace.browserName === undefined ? [] : [trace.browserName])),
  });

  const folderReady = readyOutputFolder(ports.outputDirectory, ports.checkout);
  if (!folderReady.ok) {
    return refusedSuiteResult(suiteName, refusalFor(folderReady.error));
  }

  if (suite.setupCommand !== undefined) {
    const setup = await ports.workload.run(request(suite.setupCommand, environment.value.variables));
    if (!setup.ok) return refusedSuiteResult(suiteName, refusalFor(setup.error));
    if (setup.value.kind === 'timed-out' || setup.value.exitCode !== 0) {
      // The suite never ran, but its setup ran behind the egress proxy, so its result says what the
      // proxy refused, or that the proxy's record could not be read.
      return unreadSuiteResult(context(exitCodeOf(setup.value), setup.value.kind === 'timed-out', manifestFor(null, []), egressOf(setup.value)), EvidenceOutcomeCode.SetupFailed);
    }
    if (setup.value.egressRecordUnread === true) {
      return unreadSuiteResult(context(exitCodeOf(setup.value), false, manifestFor(null, []), RECORD_UNREAD));
    }
  }

  const evidenceRemoved = await removeEarlierEvidence(ports.workload, suite.image, ports.outputDirectory);
  if (!evidenceRemoved.ok) {
    return refusedSuiteResult(suiteName, refusalFor(evidenceRemoved.error));
  }

  const built = suiteArguments(suite, WORKLOAD_OUTPUT_PATH);
  const variables: WorkloadVariable[] = [
    ...environment.value.variables,
    ...Object.entries(built.environment).map(([name, value]): WorkloadVariable => ({ name, value })),
  ];
  // The project parser refuses a declared variable of a name Revisum sets, such as the report's.
  const ran = await ports.workload.run(request(built.argv, variables));
  if (!ran.ok) return refusedSuiteResult(suiteName, refusalFor(ran.error));
  const exitCode = exitCodeOf(ran.value);
  const timedOut = ran.value.kind === 'timed-out';
  const egress = egressOf(ran.value);

  const read = readReport(ports.outputDirectory, limits);
  if (!read.ok) {
    return unreadSuiteResult(context(exitCode, timedOut, manifestFor(null, []), egress), EvidenceOutcomeCode.SuiteReportUnread, read.errors);
  }
  const { traces, decodeErrors } = readTraces(ports.outputDirectory, read.report, limits);
  return evidenceResult(read.report, traces, [], context(exitCode, timedOut, manifestFor(read.report, traces), egress, decodeErrors));
}
