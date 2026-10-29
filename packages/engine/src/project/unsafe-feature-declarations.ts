// Reads the trusted project's unsafeFeatures section: which unsafe plan features a person turned
// on, and the page scripts and database commands a plan may then name. Only this section enables a
// feature; no flag, environment variable or plan can. Every feature is off unless the section
// enables it, and inline page scripts ride on page scripts, so they cannot be on alone.
//
// The reader refuses a script file outside plans/scripts/, a secret parameter (a secret never
// reaches a page script, and reaches a command only through its declared environment), a command
// whose service is not private with a port, a command whose program a plan could choose, and an
// environment name Revisum sets itself, each with its code and JSON path and never the value.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import {
  CALL_EFFECTS, COMMAND_OUTPUTS, UNSAFE_FEATURES,
  type CommandArgument, type CommandName, type DatabaseCommandDeclaration, type DeclaredService, type PageScriptDeclaration,
  type ParameterName, type ParameterType, type SafeText, type ScriptName, type ScriptParameterType, type SecretName, type ServiceName,
  type UnsafeFeature, type UnsafeFeaturesDeclaration,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { INVALID, allValid, readInteger, readList, readOneOf, readRecord, readText, type Issues, type Parsed } from '../plan/plan-decoders.ts';
import { MAXIMUM_SELECTOR_LENGTH, SELECTOR_FORBIDDEN_CHARACTERS } from '../plan/plan-grammar.ts';
import { readDeclarationSection, readFields, readParameters } from './call-declarations.ts';
import { readEnvironmentVariables, readImageDigest } from './evidence-declarations.ts';

// What the section may refer to: the project's services and secret names.
export type UnsafeFeaturesContext = {
  readonly issues: Issues;
  readonly services: readonly DeclaredService[];
  readonly secretNames: readonly SecretName[];
};

const SECTION_FIELDS = ['cssLocators', 'xpathLocators', 'domChecks', 'pageScripts', 'databaseCommands', 'unnamedControlsAllowed'] as const;
const SWITCHES = ['cssLocators', 'xpathLocators', 'domChecks'] as const;
const PAGE_SCRIPTS_FIELDS = ['scripts', 'allowInline'] as const;
const SCRIPT_FIELDS = ['file', 'parameters', 'effect', 'fields', 'allowInProposals', 'timeoutMilliseconds', 'maximumResultBytes'] as const;
const REQUIRED_SCRIPT_FIELDS = ['file', 'parameters', 'effect'] as const;
const COMMAND_FIELDS = [
  'service', 'image', 'argv', 'parameters', 'environment', 'effect', 'successExitCodes', 'output', 'fields', 'allowInProposals',
  'timeoutMilliseconds', 'maximumOutputBytes',
] as const;
const REQUIRED_COMMAND_FIELDS = ['service', 'image', 'argv', 'parameters', 'effect', 'output'] as const;

// A script file: under plans/scripts/, a JavaScript file, with no empty, "." or ".." segment, so it
// can never name a file outside that trusted folder.
const SCRIPT_FOLDER = 'plans/scripts/';
const SCRIPT_FILE = /^plans\/scripts\/[A-Za-z0-9._/-]+\.js$/;

const MAXIMUM_SCRIPTS = 256;
const MAXIMUM_COMMANDS = 256;
const MAXIMUM_SCRIPT_FILE_LENGTH = 512;
const MAXIMUM_SCRIPT_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_SCRIPT_RESULT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ARGUMENTS = 64;
const MAXIMUM_ARGUMENT_LENGTH = 1024;
const MAXIMUM_EXIT_CODES = 32;
const LARGEST_EXIT_CODE = 255;
const DEFAULT_SUCCESS_EXIT_CODES: readonly number[] = [0];
const MAXIMUM_COMMAND_TIMEOUT_MILLISECONDS = 600_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_UNNAMED_CONTROLS = 256;

// The unsafeFeatures section, or undefined when the project has none, which enables no feature.
export function readUnsafeFeatures(input: unknown, context: UnsafeFeaturesContext): Parsed<UnsafeFeaturesDeclaration | undefined> {
  if (input === undefined) return undefined;
  const { issues } = context;
  const path = '$.unsafeFeatures';
  const fields = readRecord(input, path, issues, SECTION_FIELDS, []);
  if (fields === INVALID) return INVALID;
  const switches = SWITCHES.map((key) => readSwitch(fields, key, path, issues));
  const pageScripts = Object.hasOwn(fields, 'pageScripts') ? readPageScripts(fields['pageScripts'], `${path}.pageScripts`, issues) : undefined;
  const databaseCommands = Object.hasOwn(fields, 'databaseCommands')
    ? readDatabaseCommands(fields['databaseCommands'], `${path}.databaseCommands`, context) : undefined;
  const unnamedControlsAllowed = Object.hasOwn(fields, 'unnamedControlsAllowed')
    ? readSelectorList(fields['unnamedControlsAllowed'], `${path}.unnamedControlsAllowed`, issues) : undefined;
  if (!allValid(switches) || pageScripts === INVALID || databaseCommands === INVALID || unnamedControlsAllowed === INVALID) return INVALID;
  const [cssLocators, xpathLocators, domChecks] = switches;
  // A switch set to false and an absent one both leave the feature off, so only true is kept.
  return {
    ...(cssLocators ? { cssLocators: true } : {}),
    ...(xpathLocators ? { xpathLocators: true } : {}),
    ...(domChecks ? { domChecks: true } : {}),
    ...(pageScripts === undefined ? {} : { pageScripts }),
    ...(databaseCommands === undefined ? {} : { databaseCommands }),
    ...(unnamedControlsAllowed === undefined ? {} : { unnamedControlsAllowed }),
  };
}

// The features a section enables, in the order UNSAFE_FEATURES lists them: the one answer to
// "is this feature on?" that the plan parser reads.
export function enabledUnsafeFeatures(declaration: UnsafeFeaturesDeclaration | undefined): readonly UnsafeFeature[] {
  if (declaration === undefined) return [];
  const enabled: { readonly [Feature in UnsafeFeature]: boolean } = {
    'css-locator': declaration.cssLocators === true,
    'xpath-locator': declaration.xpathLocators === true,
    'dom-checks': declaration.domChecks === true,
    'page-script': declaration.pageScripts !== undefined,
    'inline-page-script': declaration.pageScripts?.allowInline === true,
    'database-command': declaration.databaseCommands !== undefined,
  };
  return UNSAFE_FEATURES.filter((feature) => enabled[feature]);
}

// An optional true or false; absent is false. Present but null is not "absent".
function readSwitch(fields: Readonly<Record<string, unknown>>, key: string, path: string, issues: Issues): Parsed<boolean> {
  const value = Object.hasOwn(fields, key) ? fields[key] : false;
  if (typeof value !== 'boolean') { issues.push({ code: 'wrong_type', path: `${path}.${key}` }); return INVALID; }
  return value;
}

// An optional whole number from 1 to `highest`, left out when absent.
const readOptionalLimit = (fields: Readonly<Record<string, unknown>>, key: string, path: string, issues: Issues, highest: number): Parsed<number | undefined> =>
  (Object.hasOwn(fields, key) ? readInteger(fields[key], `${path}.${key}`, issues, 1, highest) : undefined);

// A declaration's parameters, none of them a secret.
function readScriptParameters(input: unknown, path: string, issues: Issues): Parsed<Readonly<Record<ParameterName, ScriptParameterType>>> {
  const parameters = readParameters(input, path, issues);
  if (parameters === INVALID) return INVALID;
  const entries = Object.entries<ParameterType>(parameters).map(([name, type]): Parsed<readonly [string, ScriptParameterType]> => {
    if (type.kind !== 'secret') return [name, type];
    issues.push({ code: 'unknown_value', path: `${path}.${name}.kind` });
    return INVALID;
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// ---- Page scripts -------------------------------------------------------------------------------

function readPageScripts(input: unknown, path: string, issues: Issues): Parsed<NonNullable<UnsafeFeaturesDeclaration['pageScripts']>> {
  const fields = readRecord(input, path, issues, PAGE_SCRIPTS_FIELDS, ['scripts']);
  if (fields === INVALID) return INVALID;
  const allowInline = readSwitch(fields, 'allowInline', path, issues);
  const scripts = readDeclarationSection<'ScriptName', PageScriptDeclaration>(
    fields['scripts'], `${path}.scripts`, issues, MAXIMUM_SCRIPTS, (declaration, at) => readPageScript(declaration, at, issues),
  );
  return scripts === INVALID || allowInline === INVALID ? INVALID : { scripts, allowInline };
}

function readPageScript(input: unknown, path: string, issues: Issues): Parsed<PageScriptDeclaration> {
  const fields = readRecord(input, path, issues, SCRIPT_FIELDS, REQUIRED_SCRIPT_FIELDS);
  if (fields === INVALID) return INVALID;
  const resultFields = Object.hasOwn(fields, 'fields') ? readFields(fields['fields'], `${path}.fields`, issues) : undefined;
  const timeoutMilliseconds = readOptionalLimit(fields, 'timeoutMilliseconds', path, issues, MAXIMUM_SCRIPT_TIMEOUT_MILLISECONDS);
  const maximumResultBytes = readOptionalLimit(fields, 'maximumResultBytes', path, issues, MAXIMUM_SCRIPT_RESULT_BYTES);
  const parts = [
    readScriptFile(fields['file'], `${path}.file`, issues),
    readScriptParameters(fields['parameters'], `${path}.parameters`, issues),
    readOneOf(fields['effect'], `${path}.effect`, issues, CALL_EFFECTS),
    readSwitch(fields, 'allowInProposals', path, issues),
  ] as const;
  if (!allValid(parts) || resultFields === INVALID || timeoutMilliseconds === INVALID || maximumResultBytes === INVALID) return INVALID;
  const [file, parameters, effect, allowInProposals] = parts;
  // Optional parts are left out when absent.
  return {
    file, parameters, effect, ...(resultFields === undefined ? {} : { fields: resultFields }), allowInProposals,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(maximumResultBytes === undefined ? {} : { maximumResultBytes }),
  };
}

function readScriptFile(input: unknown, path: string, issues: Issues): Parsed<SafeText> {
  const file = readText(input, path, issues, MAXIMUM_SCRIPT_FILE_LENGTH);
  if (file === INVALID) return INVALID;
  const segments = file.slice(SCRIPT_FOLDER.length).split('/');
  if (!SCRIPT_FILE.test(file) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    issues.push({ code: 'path_not_allowed', path });
    return INVALID;
  }
  return file;
}

// ---- Database commands ----------------------------------------------------------------------------

function readDatabaseCommands(
  input: unknown, path: string, context: UnsafeFeaturesContext,
): Parsed<NonNullable<UnsafeFeaturesDeclaration['databaseCommands']>> {
  const fields = readRecord(input, path, context.issues, ['commands']);
  if (fields === INVALID) return INVALID;
  const commands = readDeclarationSection<'CommandName', DatabaseCommandDeclaration>(
    fields['commands'], `${path}.commands`, context.issues, MAXIMUM_COMMANDS, (declaration, at) => readCommand(declaration, at, context),
  );
  return commands === INVALID ? INVALID : { commands };
}

function readCommand(input: unknown, path: string, context: UnsafeFeaturesContext): Parsed<DatabaseCommandDeclaration> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, COMMAND_FIELDS, REQUIRED_COMMAND_FIELDS);
  if (fields === INVALID) return INVALID;
  const output = readOneOf(fields['output'], `${path}.output`, issues, COMMAND_OUTPUTS);
  // Only JSON output has fields to read.
  const hasFields = Object.hasOwn(fields, 'fields');
  if (hasFields && output === 'none') { issues.push({ code: 'unknown_field', path: `${path}.fields` }); return INVALID; }
  const outputFields = hasFields ? readFields(fields['fields'], `${path}.fields`, issues) : undefined;
  const environment = Object.hasOwn(fields, 'environment')
    ? readEnvironmentVariables(fields['environment'], `${path}.environment`, issues, context.secretNames) : undefined;
  const successExitCodes = Object.hasOwn(fields, 'successExitCodes')
    ? readExitCodes(fields['successExitCodes'], `${path}.successExitCodes`, issues) : DEFAULT_SUCCESS_EXIT_CODES;
  const timeoutMilliseconds = readOptionalLimit(fields, 'timeoutMilliseconds', path, issues, MAXIMUM_COMMAND_TIMEOUT_MILLISECONDS);
  const maximumOutputBytes = readOptionalLimit(fields, 'maximumOutputBytes', path, issues, MAXIMUM_COMMAND_OUTPUT_BYTES);
  // The argument vector names parameters, so it is read only once they are known.
  const parameters = readScriptParameters(fields['parameters'], `${path}.parameters`, issues);
  const argv = parameters === INVALID ? INVALID : readArgumentVector(fields['argv'], `${path}.argv`, issues, parameters);
  const parts = [
    readCommandService(fields['service'], `${path}.service`, context),
    readImageDigest(fields['image'], `${path}.image`, issues),
    readOneOf(fields['effect'], `${path}.effect`, issues, CALL_EFFECTS),
    readSwitch(fields, 'allowInProposals', path, issues),
  ] as const;
  if (!allValid(parts) || output === INVALID || outputFields === INVALID || environment === INVALID || successExitCodes === INVALID
    || timeoutMilliseconds === INVALID || maximumOutputBytes === INVALID || parameters === INVALID || argv === INVALID) return INVALID;
  const [service, image, effect, allowInProposals] = parts;
  // Optional parts are left out when absent.
  return {
    service, image, argv, parameters, ...(environment === undefined ? {} : { environment }), effect, successExitCodes, output,
    ...(outputFields === undefined ? {} : { fields: outputFields }), allowInProposals,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(maximumOutputBytes === undefined ? {} : { maximumOutputBytes }),
  };
}

// A declared service that may resolve to a private address and names the one port the command may
// reach. Any other service is refused: a command's network reaches nothing else.
function readCommandService(input: unknown, path: string, context: UnsafeFeaturesContext): Parsed<ServiceName> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = context.services.find((service) => service.name === input);
  if (found === undefined || !found.private || found.port === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return found.name;
}

// The argument vector: literal text or a whole argument filled by a declared parameter, with no
// shell. The first argument names the program, so it is always literal: a plan never chooses what
// runs.
function readArgumentVector(
  input: unknown, path: string, issues: Issues, parameters: Readonly<Record<ParameterName, ScriptParameterType>>,
): Parsed<readonly CommandArgument[]> {
  const raw = readList(input, path, issues, MAXIMUM_ARGUMENTS);
  if (raw === INVALID) return INVALID;
  const argv = raw.map((entry, index): Parsed<CommandArgument> => {
    const at = `${path}[${index}]`;
    if (typeof entry === 'object' && entry !== null && Object.hasOwn(entry, '$parameter')) {
      const fields = readRecord(entry, at, issues, ['$parameter']);
      if (fields === INVALID) return INVALID;
      const name = Object.keys(parameters).find((parameter) => parameter === fields['$parameter']);
      if (name === undefined || index === 0) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
      return { $parameter: brand<string, 'ParameterName'>(name) };
    }
    const fields = readRecord(entry, at, issues, ['literal']);
    if (fields === INVALID) return INVALID;
    const literal = readText(fields['literal'], `${at}.literal`, issues, MAXIMUM_ARGUMENT_LENGTH);
    return literal === INVALID ? INVALID : { literal };
  });
  return allValid(argv) ? argv : INVALID;
}

function readExitCodes(input: unknown, path: string, issues: Issues): Parsed<readonly number[]> {
  const raw = readList(input, path, issues, MAXIMUM_EXIT_CODES);
  if (raw === INVALID) return INVALID;
  const codes = raw.map((code, index) => readInteger(code, `${path}[${index}]`, issues, 0, LARGEST_EXIT_CODE));
  if (!allValid(codes)) return INVALID;
  if (new Set(codes).size !== codes.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return codes;
}

// ---- Unnamed controls ---------------------------------------------------------------------------------

// Exact CSS selectors or XPath expressions, under the rules a plan's selector follows, each once.
function readSelectorList(input: unknown, path: string, issues: Issues): Parsed<readonly SafeText[]> {
  const raw = readList(input, path, issues, MAXIMUM_UNNAMED_CONTROLS, 0);
  if (raw === INVALID) return INVALID;
  const selectors = raw.map((value, index): Parsed<SafeText> => {
    const at = `${path}[${index}]`;
    const selector = readText(value, at, issues, MAXIMUM_SELECTOR_LENGTH);
    if (selector !== INVALID && SELECTOR_FORBIDDEN_CHARACTERS.test(selector)) { issues.push({ code: 'unsafe_text', path: at }); return INVALID; }
    return selector;
  });
  if (!allValid(selectors)) return INVALID;
  if (new Set(selectors).size !== selectors.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return selectors;
}

// The declarations a section holds, by kind, for the plan parser and the policy gate. Each is empty
// when its feature is off.
export const declaredScripts = (declaration: UnsafeFeaturesDeclaration | undefined): Readonly<Record<ScriptName, PageScriptDeclaration>> =>
  declaration?.pageScripts?.scripts ?? {};
export const declaredCommands = (declaration: UnsafeFeaturesDeclaration | undefined): Readonly<Record<CommandName, DatabaseCommandDeclaration>> =>
  declaration?.databaseCommands?.commands ?? {};
