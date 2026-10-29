// Reads the trusted project's evidenceMode section: the team's own Playwright suites Revisum may
// run, and the limits their outputs are decoded under. Only this section turns evidence mode on;
// no flag, environment variable or plan can. The reader refuses a suite that could run something
// other than Playwright Test, reach outside the repository, override what Revisum sets in the
// suite's environment, or hold a secret, with the code and JSON path and never the value.
// See docs/specs/SPEC-35-evidence-mode.md.
import type {
  EnvironmentValue, EvidenceLimits, EvidenceMode, EvidenceSuiteDeclaration, ImageDigest, SafeText, SecretName, SuiteName,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { looksLikeCredential } from '../plan/literal-secrets.ts';
import {
  INVALID, allValid, readInteger, readList, readOneOf, readRecord, readText, type Issues, type Parsed,
} from '../plan/plan-decoders.ts';
import { staysInside } from '../relative-paths.ts';
import { readDeclarationSection } from './call-declarations.ts';

const SUITE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
// An environment-variable style name, such as BASE_URL.
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Names Revisum sets itself in the suite's environment, so a declaration may not: the search path,
// home folder and Node options, Playwright's own settings, every proxy setting (which would route
// round the egress proxy), and the CI and GitHub variables, which can carry tokens. Compared
// without case, because Windows and many tools read environment names that way.
const RESERVED_ENVIRONMENT_NAMES: readonly string[] = ['PATH', 'HOME', 'NODE_OPTIONS', 'CI'];
const RESERVED_ENVIRONMENT_PREFIXES: readonly string[] = ['PLAYWRIGHT_', 'PW_', 'GITHUB_'];
const RESERVED_ENVIRONMENT_SUFFIX = '_PROXY';

export function isReservedEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENVIRONMENT_NAMES.includes(upper) || upper.endsWith(RESERVED_ENVIRONMENT_SUFFIX)
    || RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// The ways a command may invoke Playwright Test: directly, or through npx.
const PLAYWRIGHT_TEST_INVOCATIONS: readonly (readonly string[])[] = [['playwright', 'test'], ['npx', 'playwright', 'test']];
// Arguments Revisum appends to every suite command: the JSON reporter into its own output
// directory, traces on, no retries, the declared projects and timeout. The declaration may not set
// them, whether written "--name value" or "--name=value".
const ARGUMENTS_REVISUM_SETS: readonly string[] = ['--reporter', '--output', '--trace', '--retries', '--project', '--timeout'];

const MAXIMUM_SUITES = 32;
const MAXIMUM_PATHS = 64;
const MAXIMUM_PATH_LENGTH = 512;
const MAXIMUM_ARGUMENTS = 64;
const MAXIMUM_ARGUMENT_LENGTH = 1024;
const MAXIMUM_PROJECTS = 32;
const MAXIMUM_PROJECT_NAME_LENGTH = 100;
const MAXIMUM_ENVIRONMENT_VARIABLES = 64;
const MAXIMUM_LITERAL_LENGTH = 4000;
const MINUTE_IN_MILLISECONDS = 60 * 1000;
const DEFAULT_SUITE_TIMEOUT_MILLISECONDS = 30 * MINUTE_IN_MILLISECONDS;
const MAXIMUM_SUITE_TIMEOUT_MILLISECONDS = 6 * 60 * MINUTE_IN_MILLISECONDS;
const MEBIBYTE = 1024 * 1024;

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  maximumReportBytes: 50 * MEBIBYTE, maximumTests: 5000, maximumTraceBytes: 100 * MEBIBYTE, maximumTraceEntries: 20_000,
  maximumAuditedPages: 200,
};
// The largest value a project may set for each evidence limit. Every limit is a whole number of at least 1.
const EVIDENCE_LIMIT_CEILINGS: { readonly [Key in keyof Required<EvidenceLimits>]: number } = {
  maximumReportBytes: 1024 * MEBIBYTE, maximumTests: 100_000, maximumTraceBytes: 1024 * MEBIBYTE, maximumTraceEntries: 1_000_000,
  maximumAuditedPages: 10_000, maximumReportDepth: 256,
};
const isEvidenceLimitKey = (key: string): key is keyof Required<EvidenceLimits> => Object.hasOwn(EVIDENCE_LIMIT_CEILINGS, key);
const EVIDENCE_LIMIT_KEYS: readonly (keyof Required<EvidenceLimits>)[] = Object.keys(EVIDENCE_LIMIT_CEILINGS).filter(isEvidenceLimitKey);

const SECTION_FIELDS = ['suites', 'limits'] as const;
const SUITE_FIELDS = [
  'name', 'framework', 'paths', 'workingDirectory', 'image', 'setupCommand', 'command', 'projects', 'environment',
  'runChangedTestsAsProposal', 'keepTraces', 'keepSuiteScreenshots', 'timeoutMilliseconds',
] as const;
const REQUIRED_SUITE_FIELDS = ['name', 'framework', 'paths', 'workingDirectory', 'image', 'command', 'projects'] as const;
const FRAMEWORKS = ['playwright-test'] as const;

// What a suite declaration may refer to: the project's secret names.
type SuiteContext = { readonly issues: Issues; readonly secretNames: readonly SecretName[] };

// The evidenceMode section, or undefined when the project has none, which means evidence mode is off.
export function readEvidenceMode(input: unknown, issues: Issues, secretNames: readonly SecretName[]): Parsed<EvidenceMode | undefined> {
  if (input === undefined) return undefined;
  const path = '$.evidenceMode';
  const fields = readRecord(input, path, issues, SECTION_FIELDS, ['suites']);
  if (fields === INVALID) return INVALID;
  const context: SuiteContext = { issues, secretNames };
  const limits = readEvidenceLimits(fields['limits'], `${path}.limits`, issues);
  const raw = readList(fields['suites'], `${path}.suites`, issues, MAXIMUM_SUITES);
  if (raw === INVALID || limits === INVALID) return INVALID;
  const suites = raw.map((suite, index) => readSuite(suite, `${path}.suites[${index}]`, context));
  if (!allValid(suites)) return INVALID;
  const seen = new Set<string>();
  for (const [index, suite] of suites.entries()) {
    if (seen.has(suite.name)) { issues.push({ code: 'duplicate', path: `${path}.suites[${index}].name` }); return INVALID; }
    seen.add(suite.name);
  }
  return { suites, limits };
}

// Each limit the project sets, within its ceiling, and the default for the rest. The report depth
// is kept only when set, so a project that leaves it out reads exactly the default limits.
function readEvidenceLimits(input: unknown, path: string, issues: Issues): Parsed<EvidenceLimits> {
  if (input === undefined) return DEFAULT_EVIDENCE_LIMITS;
  const fields = readRecord(input, path, issues, EVIDENCE_LIMIT_KEYS, []);
  if (fields === INVALID) return INVALID;
  const limits: { -readonly [Key in keyof EvidenceLimits]: EvidenceLimits[Key] } = { ...DEFAULT_EVIDENCE_LIMITS };
  let valid = true;
  for (const key of EVIDENCE_LIMIT_KEYS) {
    if (fields[key] === undefined) continue;
    const value = readInteger(fields[key], `${path}.${key}`, issues, 1, EVIDENCE_LIMIT_CEILINGS[key]);
    if (value === INVALID) valid = false;
    else limits[key] = value;
  }
  return valid ? limits : INVALID;
}

function readSuite(input: unknown, path: string, context: SuiteContext): Parsed<EvidenceSuiteDeclaration> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, SUITE_FIELDS, REQUIRED_SUITE_FIELDS);
  if (fields === INVALID) return INVALID;
  const setupCommand = fields['setupCommand'] === undefined ? undefined : readArgumentVector(fields['setupCommand'], `${path}.setupCommand`, issues);
  const parts = [
    readSuiteName(fields['name'], `${path}.name`, issues),
    readOneOf(fields['framework'], `${path}.framework`, issues, FRAMEWORKS),
    readSuitePaths(fields['paths'], `${path}.paths`, issues),
    readInsidePath(fields['workingDirectory'], `${path}.workingDirectory`, issues),
    readImageDigest(fields['image'], `${path}.image`, issues),
    readPlaywrightCommand(fields['command'], `${path}.command`, issues),
    readProjects(fields['projects'], `${path}.projects`, issues),
    readEnvironment(fields['environment'], `${path}.environment`, context),
    readSetting(fields, 'runChangedTestsAsProposal', path, issues, true),
    readSetting(fields, 'keepTraces', path, issues, true),
    readSetting(fields, 'keepSuiteScreenshots', path, issues, false),
    fields['timeoutMilliseconds'] === undefined
      ? DEFAULT_SUITE_TIMEOUT_MILLISECONDS
      : readInteger(fields['timeoutMilliseconds'], `${path}.timeoutMilliseconds`, issues, 1, MAXIMUM_SUITE_TIMEOUT_MILLISECONDS),
  ] as const;
  if (!allValid(parts) || setupCommand === INVALID) return INVALID;
  const [
    name, framework, paths, workingDirectory, image, command, projects, environment, runChangedTestsAsProposal, keepTraces,
    keepSuiteScreenshots, timeoutMilliseconds,
  ] = parts;
  return {
    name, framework, paths, workingDirectory, image, ...(setupCommand === undefined ? {} : { setupCommand }), command, projects,
    environment, runChangedTestsAsProposal, keepTraces, keepSuiteScreenshots, timeoutMilliseconds,
  };
}

function readSuiteName(input: unknown, path: string, issues: Issues): Parsed<SuiteName> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!SUITE_NAME.test(input)) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, 'SuiteName'>(input);
}

// Anything but "sha256:" and 64 lowercase hex digits, a tag included, is the wrong kind of value.
export function readImageDigest(input: unknown, path: string, issues: Issues): Parsed<ImageDigest> {
  if (typeof input !== 'string' || !IMAGE_DIGEST.test(input)) { issues.push({ code: 'wrong_type', path }); return INVALID; }
  return brand<string, 'ImageDigest'>(input);
}

// Repository-relative text that stays inside the repository.
function readInsidePath(input: unknown, path: string, issues: Issues): Parsed<SafeText> {
  const text = readText(input, path, issues, MAXIMUM_PATH_LENGTH);
  if (text === INVALID) return INVALID;
  if (!staysInside(text)) { issues.push({ code: 'path_not_allowed', path }); return INVALID; }
  return text;
}

function readSuitePaths(input: unknown, path: string, issues: Issues): Parsed<readonly SafeText[]> {
  const raw = readList(input, path, issues, MAXIMUM_PATHS);
  if (raw === INVALID) return INVALID;
  const paths = raw.map((entry, index) => readInsidePath(entry, `${path}[${index}]`, issues));
  if (!allValid(paths)) return INVALID;
  if (new Set(paths).size !== paths.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return paths;
}

// An argument vector: each argument is passed to the process as it is, with no shell.
function readArgumentVector(input: unknown, path: string, issues: Issues): Parsed<readonly SafeText[]> {
  const raw = readList(input, path, issues, MAXIMUM_ARGUMENTS);
  if (raw === INVALID) return INVALID;
  const argumentVector = raw.map((entry, index) => readText(entry, `${path}[${index}]`, issues, MAXIMUM_ARGUMENT_LENGTH));
  return allValid(argumentVector) ? argumentVector : INVALID;
}

// The suite command: an invocation of Playwright Test, then the team's own arguments, none of them
// one Revisum appends itself.
function readPlaywrightCommand(input: unknown, path: string, issues: Issues): Parsed<readonly SafeText[]> {
  const command = readArgumentVector(input, path, issues);
  if (command === INVALID) return INVALID;
  const invocation = PLAYWRIGHT_TEST_INVOCATIONS.find((prefix) => prefix.every((word, index) => command[index] === word));
  const ownArguments = invocation === undefined ? [] : command.slice(invocation.length);
  const setsOwnArgument = ownArguments.some((argument) =>
    ARGUMENTS_REVISUM_SETS.some((name) => argument === name || argument.startsWith(`${name}=`)));
  if (invocation === undefined || setsOwnArgument) { issues.push({ code: 'command_not_allowed', path }); return INVALID; }
  return command;
}

function readProjects(input: unknown, path: string, issues: Issues): Parsed<readonly SafeText[]> {
  const raw = readList(input, path, issues, MAXIMUM_PROJECTS);
  if (raw === INVALID) return INVALID;
  const projects = raw.map((entry, index) => readText(entry, `${path}[${index}]`, issues, MAXIMUM_PROJECT_NAME_LENGTH));
  if (!allValid(projects)) return INVALID;
  if (new Set(projects).size !== projects.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return projects;
}

// The variables a process receives, by name, under the same rules as a suite's environment: a
// database command's environment is read this way too.
export const readEnvironmentVariables = (
  input: unknown, path: string, issues: Issues, secretNames: readonly SecretName[],
): Parsed<Readonly<Record<string, EnvironmentValue>>> => readEnvironment(input, path, { issues, secretNames });

// The variables the suite's process receives, by name; absent means none. A reserved name is
// refused at the name, with nothing under it read.
function readEnvironment(input: unknown, path: string, context: SuiteContext): Parsed<Readonly<Record<string, EnvironmentValue>>> {
  return readDeclarationSection<'EnvironmentName', EnvironmentValue>(
    input, path, context.issues, MAXIMUM_ENVIRONMENT_VARIABLES, (value, at) => readEnvironmentValue(value, at, context),
    { pattern: ENVIRONMENT_NAME, allowed: (name) => !isReservedEnvironmentName(name) },
  );
}

// { literal } with text that is not shaped like a credential, or { secretName } naming a secret
// the project declares.
function readEnvironmentValue(input: unknown, path: string, context: SuiteContext): Parsed<EnvironmentValue> {
  const { issues } = context;
  if (typeof input === 'object' && input !== null && Object.hasOwn(input, 'literal')) {
    const fields = readRecord(input, path, issues, ['literal']);
    if (fields === INVALID) return INVALID;
    const at = `${path}.literal`;
    const literal = readText(fields['literal'], at, issues, MAXIMUM_LITERAL_LENGTH, 0);
    if (literal === INVALID) return INVALID;
    if (looksLikeCredential(literal)) { issues.push({ code: 'literal_secret', path: at }); return INVALID; }
    return { literal };
  }
  const fields = readRecord(input, path, issues, ['secretName']);
  if (fields === INVALID) return INVALID;
  const at = `${path}.secretName`;
  const secretName = fields['secretName'];
  if (typeof secretName !== 'string') { issues.push({ code: 'wrong_type', path: at }); return INVALID; }
  const found = context.secretNames.find((name) => name === secretName);
  if (found === undefined) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
  return { secretName: found };
}

// An optional true or false; absent keeps `fallback`. Present but null is not "absent".
function readSetting(fields: Readonly<Record<string, unknown>>, key: string, path: string, issues: Issues, fallback: boolean): Parsed<boolean> {
  const value = Object.hasOwn(fields, key) ? fields[key] : fallback;
  if (typeof value !== 'boolean') { issues.push({ code: 'wrong_type', path: `${path}.${key}` }); return INVALID; }
  return value;
}
