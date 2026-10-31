// Unsafe plan features: escape hatches from the closed plan language that a team may turn on, one
// at a time, in its trusted project file. Each is off unless a person enables it, and a run that
// uses any of them is labelled unsafe, runs at the host level and never counts as verified
// evidence, because it gives up guarantees the closed language keeps:
//   - css-locator and xpath-locator find elements by page structure, not by role or name;
//   - dom-checks read classes, computed styles and attributes, not what a user perceives;
//   - page-script runs a script the project declares, by name, in the page;
//   - inline-page-script runs a script whose text is in the plan itself (it needs page-script);
//   - database-command runs a command the project declares, by name, against a declared database.
// Plan language 1.3 holds them; a plan declaring an older version cannot.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import type { Brand } from './brand.ts';
import type { EgressPolicy } from './isolated-runner.ts';
import type { Result } from './result.ts';
import type { WorkloadErrorCode, WorkloadOutcome, WorkloadVariable } from './workload.ts';
import type { EnvironmentValue, ImageDigest } from './evidence-mode.ts';
import type { CriterionId, SafeText, TextOrValue, ValueName } from './plan.ts';
import type { BackendAssertion, CallEffect, FieldName, JsonPointer, ParameterName, ParameterType, ServiceName } from './service-calls.ts';

export const UNSAFE_FEATURES = ['css-locator', 'xpath-locator', 'dom-checks', 'page-script', 'inline-page-script', 'database-command'] as const;
export type UnsafeFeature = (typeof UNSAFE_FEATURES)[number];

// ---- Declarations in the trusted project ------------------------------------------------------

// A declared page script's or database command's name, such as "readCart": a lowercase letter,
// then up to 63 letters and digits.
export type ScriptName = Brand<string, 'ScriptName'>;
export type CommandName = Brand<string, 'CommandName'>;

// What a script's or command's parameter accepts: any call parameter type but a secret. A secret
// never reaches a page script, and reaches a command only through its declared environment.
export type ScriptParameterType = Exclude<ParameterType, { readonly kind: 'secret' }>;

// A script file under plans/scripts/, which is a trusted path: the protected branch's version is
// the one that runs. The script is one function; its arguments are passed as JSON values, never
// spliced into its source, and only its declared result fields are read.
export type PageScriptDeclaration = {
  // Repository-relative, under plans/scripts/, ending in ".js".
  readonly file: SafeText;
  readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
  // read: the person declares the script changes nothing, so a check may repeat it.
  readonly effect: CallEffect;
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  readonly allowInProposals: boolean;
  // Defaults: 5 s and 256 KiB.
  readonly timeoutMilliseconds?: number;
  readonly maximumResultBytes?: number;
};

// One argument of a command's argument vector: literal text, or a whole argument filled by a
// parameter. There is no shell, so no argument can become two.
export type CommandArgument = { readonly literal: SafeText } | { readonly $parameter: ParameterName };

export const COMMAND_OUTPUTS = ['none', 'json'] as const;
export type CommandOutput = (typeof COMMAND_OUTPUTS)[number];

// A command run in a workload container whose network reaches only its service's address and port.
export type DatabaseCommandDeclaration = {
  // A declared service that is private and has a port.
  readonly service: ServiceName;
  readonly image: ImageDigest;
  readonly argv: readonly CommandArgument[];
  readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
  // Literals and secrets, by variable name; the names Revisum sets itself are refused.
  readonly environment?: Readonly<Record<string, EnvironmentValue>>;
  readonly effect: CallEffect;
  readonly successExitCodes: readonly number[];
  readonly output: CommandOutput;
  // Only with output "json".
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  readonly allowInProposals: boolean;
  // Defaults: 60 s and 1 MiB.
  readonly timeoutMilliseconds?: number;
  readonly maximumOutputBytes?: number;
};

// The project's unsafeFeatures section. A feature left out is off; a project without the section
// enables none.
export type UnsafeFeaturesDeclaration = {
  readonly cssLocators?: true;
  readonly xpathLocators?: true;
  readonly domChecks?: true;
  // Inline scripts ride on page scripts: allowInline turns them on.
  readonly pageScripts?: { readonly scripts: Readonly<Record<ScriptName, PageScriptDeclaration>>; readonly allowInline: boolean };
  readonly databaseCommands?: { readonly commands: Readonly<Record<CommandName, DatabaseCommandDeclaration>> };
  // Exact CSS selectors or XPath expressions that may resolve a control with no accessible name.
  readonly unnamedControlsAllowed?: readonly SafeText[];
};

// ---- What a plan writes --------------------------------------------------------------------------

// A script's source text as a plan holds it: 1 to 4,000 characters, line breaks allowed, no other
// control or bidirectional-override characters. It is code, so it is never SafeText.
export type ScriptSource = Brand<string, 'ScriptSource'>;
// A script written into the plan.
export type InlineScript = {
  readonly source: ScriptSource;
  readonly effect: CallEffect;
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
};
// A declared script by name, or an inline one.
export type ScriptChoice = ScriptName | { readonly inline: InlineScript };

// An argument: literal text or a run value, a number or a boolean. Never a secret.
export type ScriptArgument = TextOrValue | number | boolean;
export type ScriptArguments = Readonly<Record<ParameterName, ScriptArgument>>;

// Runs a page script and may remember fields of its result as run values.
export type EvaluateStep = {
  readonly type: 'evaluate'; readonly script: ScriptChoice; readonly arguments: ScriptArguments;
  readonly remember?: Readonly<Record<ValueName, FieldName>>;
};
// Runs a read script and checks one field of its result, repeating until the check passes or the
// project's script check timeout runs out.
export type ExpectScriptStep = {
  readonly type: 'expectScript'; readonly script: ScriptChoice; readonly arguments: ScriptArguments; readonly field: FieldName;
  readonly assert: BackendAssertion; readonly criterionId: CriterionId;
};
// Runs a declared database command and may remember fields of its JSON output.
export type DatabaseStep = {
  readonly type: 'database'; readonly command: CommandName; readonly arguments: ScriptArguments;
  readonly remember?: Readonly<Record<ValueName, FieldName>>;
};
// Runs a declared read command and checks one field of its output, repeating like a backend check.
export type ExpectDatabaseStep = {
  readonly type: 'expectDatabase'; readonly command: CommandName; readonly arguments: ScriptArguments; readonly field: FieldName;
  readonly assert: BackendAssertion; readonly criterionId: CriterionId;
};
export type PageScriptStep = EvaluateStep | ExpectScriptStep;
export type DatabaseCommandStep = DatabaseStep | ExpectDatabaseStep;

// ---- The database-command port -------------------------------------------------------------------

// One run of a declared database command, built by the engine from the declaration alone. Each
// argument is whole: the runner hands the vector to the program with no shell, so nothing is split
// or joined. A secret in the environment stays an opaque Secret until the runner writes the
// container's environment. The policy reaches only the command's own service, over TCP.
export type DatabaseCommandRequest = {
  readonly image: ImageDigest;
  readonly argv: readonly string[];
  readonly environment: readonly WorkloadVariable[];
  readonly policy: EgressPolicy;
  readonly timeoutMilliseconds: number;
  // The most the command may print on standard output; more fails the step.
  readonly maximumOutputBytes: number;
};

// Runs a database command in a workload container. cli wires it to runner's WorkloadRunner, so the
// engine never imports runner. The reply is the workload runner's own; the engine judges it.
export interface DatabaseCommandRunner {
  run(request: DatabaseCommandRequest): Promise<Result<WorkloadOutcome, WorkloadErrorCode>>;
}
