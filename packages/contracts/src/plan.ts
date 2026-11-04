// The plan language: a closed, versioned union of steps. An AI or a person may propose a plan,
// but only the engine's plan parser can produce the branded Plan that the interpreter accepts.
// The types live here because drivers act on steps and locators; the parser lives in the engine.
import type { Brand } from './brand.ts';
import type { ClipboardRead, ClockAndClipboardStep } from './clock-and-clipboard.ts';
import type { Key } from './Key.ts';
import type { NetworkAndStorageStep, RequestName, ResponseRead } from './network-and-storage.ts';
import type { Role } from './Role.ts';
import type { BackendAssertion, CallArguments, CallName, FieldName } from './service-calls.ts';
import type { TargetId } from './target.ts';
import type { DatabaseCommandStep, DatabaseStep, PageScriptStep } from './unsafe-plan-features.ts';

// The one language version the running engine parses. A plan declares it as text, "1.3", and any
// other version is refused. An unsafe feature needs the trusted project to enable it, not a version
// (unsafe-plan-features.ts).
export const PLAN_VERSION = { major: 1, minor: 3 } as const;

// Text that passed the engine's safety rules: no control or bidirectional-override characters
// and nothing that looks like script.
export type SafeText = Brand<string, 'SafeText'>;

// ---- Run values -----------------------------------------------------------------------------
// A plan may name values and use them where it would write literal text for the page. A
// generated value derives from the run's seed and clock start; a remembered value is read from
// the page by a remember step. Plans stay straight-line: there is no arithmetic or branching.

// A run value's name, such as "orderCode": a lowercase letter, then letters and digits.
export type ValueName = Brand<string, 'ValueName'>;
export type ValueReference = { readonly valueName: ValueName };
// Literal text, or a reference to a run value that the run replaces with its text.
export type TextOrValue = SafeText | ValueReference;

// Days a date value counts from, in the target's time zone. Weeks start on Monday.
export const DateAnchor = {
  Today: 'today',
  StartOfWeek: 'startOfWeek',
  StartOfMonth: 'startOfMonth',
  StartOfNextMonth: 'startOfNextMonth',
} as const;
export type DateAnchor = (typeof DateAnchor)[keyof typeof DateAnchor];
export const DATE_ANCHORS: readonly DateAnchor[] = Object.values(DateAnchor);
// How a date value is written: yearMonthDay "2026-11-02"; dayOfMonth "2"; monthAndYear
// "November 2026", longDate "2 November 2026" and weekday "Monday" in the target's locale;
// timestamp "2026-11-02T00:00:00.000Z" and epochMilliseconds "1793577600000" (for a target in UTC),
// both naming midnight at the start of that day in the target's time zone.
export const DateFormat = {
  YearMonthDay: 'yearMonthDay',
  DayOfMonth: 'dayOfMonth',
  MonthAndYear: 'monthAndYear',
  LongDate: 'longDate',
  Weekday: 'weekday',
  Timestamp: 'timestamp',
  EpochMilliseconds: 'epochMilliseconds',
} as const;
export type DateFormat = (typeof DateFormat)[keyof typeof DateFormat];
export const DATE_FORMATS: readonly DateFormat[] = Object.values(DateFormat);
// A day relative to an anchor. addDays is a whole number from -3660 to 3660.
export type RelativeDay = { readonly from: DateAnchor; readonly addDays: number };

// An email domain the trusted project declares in generatedEmailDomains.
export type EmailDomain = Brand<string, 'EmailDomain'>;
export const GeneratedValueKind = {
  UniqueText: 'uniqueText',
  UniqueEmail: 'uniqueEmail',
  UniqueNumber: 'uniqueNumber',
  Date: 'date',
} as const;
export type GeneratedValueKind = (typeof GeneratedValueKind)[keyof typeof GeneratedValueKind];
export const GENERATED_VALUE_KINDS: readonly GeneratedValueKind[] = Object.values(GeneratedValueKind);
export type GeneratedValue =
  // prefix, "-" and 10 base-36 characters.
  | { readonly kind: typeof GeneratedValueKind.UniqueText; readonly prefix: SafeText }
  // localPrefix, "-", 10 base-36 characters, "@" and the domain (by default the first declared one).
  | { readonly kind: typeof GeneratedValueKind.UniqueEmail; readonly localPrefix: SafeText; readonly domain?: EmailDomain }
  // 4 to 12 digits, never starting with 0.
  | { readonly kind: typeof GeneratedValueKind.UniqueNumber; readonly digits: number }
  | { readonly kind: typeof GeneratedValueKind.Date; readonly day: RelativeDay; readonly format: DateFormat };

// The page's frozen clock, relative to the run's clock start, in the target's time zone.
// `time` is "HH:MM" on the 24-hour clock.
export type PlanClock = { readonly day: RelativeDay; readonly time: string };

// ---- Locators -------------------------------------------------------------------------------

// Which of several matching elements a locator picks, in document order: the first, the last,
// or the nth (1 to 1000). A positioned locator resolves to at most one element.
export const PositionWord = {
  First: 'first',
  Last: 'last',
} as const;
export type PositionWord = (typeof PositionWord)[keyof typeof PositionWord];
export const POSITION_WORDS: readonly PositionWord[] = Object.values(PositionWord);
export type Position = PositionWord | number;
// An attribute a testId locator may match: "id" or a data- attribute the project declares.
export type TestIdAttribute = Brand<string, 'TestIdAttribute'>;

export const SemanticLocatorKind = {
  Role: 'role',
  Label: 'label',
  Text: 'text',
  TestId: 'testId',
} as const;
export type SemanticLocatorKind = (typeof SemanticLocatorKind)[keyof typeof SemanticLocatorKind];
export const SEMANTIC_LOCATOR_KINDS: readonly SemanticLocatorKind[] = Object.values(SemanticLocatorKind);
export const LOCATOR_KINDS = SEMANTIC_LOCATOR_KINDS;
export const StructuralLocatorKind = {
  Css: 'css',
  Xpath: 'xpath',
} as const;
export type StructuralLocatorKind = (typeof StructuralLocatorKind)[keyof typeof StructuralLocatorKind];
export const STRUCTURAL_LOCATOR_KINDS: readonly StructuralLocatorKind[] = Object.values(StructuralLocatorKind);

// Role-first and name-first locators: what the closed language finds elements by. `Text` is what
// the locator's text fields hold: in a plan, literal text or a value reference; once the run has
// replaced every reference, only text.
export type SemanticLocatorWith<Text> =
  | { readonly by: typeof SemanticLocatorKind.Role; readonly role: Role; readonly name: Text; readonly position?: Position }
  | { readonly by: typeof SemanticLocatorKind.Label; readonly label: Text; readonly position?: Position }
  | { readonly by: typeof SemanticLocatorKind.Text; readonly text: Text; readonly position?: Position }
  | { readonly by: typeof SemanticLocatorKind.TestId; readonly testId: Text; readonly attribute?: TestIdAttribute; readonly position?: Position };
// css and XPath locators: unsafe features a trusted project may enable (unsafe-plan-features.ts).
// They find elements by page structure. The selector or expression is literal plan text, never a
// value reference, so what it can match is fixed when the plan is approved; only hasText may hold
// a value reference. hasText keeps the matches whose normalised text contains it, and inside
// evaluates the selector within the one element another locator finds, up to 3 deep.
export type StructuralLocatorWith<Text> =
  | {
    readonly by: typeof StructuralLocatorKind.Css; readonly selector: SafeText; readonly hasText?: Text; readonly inside?: LocatorWith<Text>;
    readonly position?: Position;
  }
  | {
    readonly by: typeof StructuralLocatorKind.Xpath; readonly expression: SafeText; readonly hasText?: Text; readonly inside?: LocatorWith<Text>;
    readonly position?: Position;
  };
export type LocatorWith<Text> = SemanticLocatorWith<Text> | StructuralLocatorWith<Text>;
export type Locator = LocatorWith<TextOrValue>;
// A locator whose value references the run has replaced with their text: what a driver receives.
// A driver resolves a css or XPath one only when it declares the structuralLocators feature.
export type ResolvedLocator = LocatorWith<SafeText>;

// ---- Keys -----------------------------------------------------------------------------------

// Held down, in the order written, while a key is pressed. ControlOrMeta is Meta on macOS and
// iOS targets and Control on every other target.
export const Modifier = {
  Alt: 'Alt',
  Control: 'Control',
  Meta: 'Meta',
  Shift: 'Shift',
  ControlOrMeta: 'ControlOrMeta',
} as const;
export type Modifier = (typeof Modifier)[keyof typeof Modifier];
export const MODIFIERS: readonly Modifier[] = Object.values(Modifier);

// ---- Assertions -----------------------------------------------------------------------------

// A closed set of assertions. What "passed" means is decided by the engine's oracle, never by a
// driver or an AI. The kind names the check; `value` is what it compares against.
// State checks compare against nothing. `absent` means no element matches at all, unlike
// `hidden`, which also passes for one element that is present but not shown. From `selected` on,
// the states are read from the accessibility tree (aria-selected, aria-expanded, aria-pressed,
// aria-current and their native equivalents); an element that does not expose the state fails
// the check, never passes it.
export const ElementStateKind = {
  Visible: 'visible',
  Hidden: 'hidden',
  Enabled: 'enabled',
  Disabled: 'disabled',
  Absent: 'absent',
  Checked: 'checked',
  Unchecked: 'unchecked',
  Focused: 'focused',
  Selected: 'selected',
  Unselected: 'unselected',
  Expanded: 'expanded',
  Collapsed: 'collapsed',
  Pressed: 'pressed',
  Unpressed: 'unpressed',
  Current: 'current',
} as const;
export type ElementStateKind = (typeof ElementStateKind)[keyof typeof ElementStateKind];
export const ELEMENT_STATE_KINDS: readonly ElementStateKind[] = Object.values(ElementStateKind);
// Text checks compare against non-empty text: an empty expected text would match anything.
export const ElementTextKind = {
  TextEquals: 'textEquals',
  TextContains: 'textContains',
  ValueEquals: 'valueEquals',
  ValueContains: 'valueContains',
} as const;
export type ElementTextKind = (typeof ElementTextKind)[keyof typeof ElementTextKind];
export const ELEMENT_TEXT_KINDS: readonly ElementTextKind[] = Object.values(ElementTextKind);
// Checks of what a user perceives or assistive technology exposes.
export type ObservableElementAssertionWith<Text> =
  | { readonly kind: ElementStateKind }
  | { readonly kind: ElementTextKind; readonly value: Text }
  | { readonly kind: typeof ElementAssertionKind.CountEquals; readonly value: number }
  // A link's href, resolved to an absolute URL, compared as text. The link is never followed.
  | { readonly kind: typeof ElementAssertionKind.HrefEquals; readonly value: Text };
// DOM checks: an unsafe feature a trusted project may enable (unsafe-plan-features.ts). They read
// implementation details: one class token, a computed style compared with the text
// getComputedStyle gives (such as "rgb(220, 38, 38)"), or an attribute by its lowercase name.
export const DomCheckKind = {
  HasClass: 'hasClass',
  LacksClass: 'lacksClass',
  ComputedStyleEquals: 'computedStyleEquals',
  AttributeEquals: 'attributeEquals',
  AttributeAbsent: 'attributeAbsent',
} as const;
export type DomCheckKind = (typeof DomCheckKind)[keyof typeof DomCheckKind];
export const DOM_CHECK_KINDS: readonly DomCheckKind[] = Object.values(DomCheckKind);
export type DomCheckWith<Text> =
  | { readonly kind: typeof DomCheckKind.HasClass | typeof DomCheckKind.LacksClass; readonly value: SafeText }
  | { readonly kind: typeof DomCheckKind.ComputedStyleEquals; readonly property: SafeText; readonly value: SafeText }
  | { readonly kind: typeof DomCheckKind.AttributeEquals; readonly name: SafeText; readonly value: Text }
  | { readonly kind: typeof DomCheckKind.AttributeAbsent; readonly name: SafeText };
export const ElementAssertionKind = {
  ...ElementStateKind,
  ...ElementTextKind,
  CountEquals: 'countEquals',
  HrefEquals: 'hrefEquals',
  ...DomCheckKind,
} as const;
export type ElementAssertionKind = (typeof ElementAssertionKind)[keyof typeof ElementAssertionKind];
export type ElementAssertionWith<Text> = ObservableElementAssertionWith<Text> | DomCheckWith<Text>;
export type ElementAssertion = ElementAssertionWith<TextOrValue>;
// An element assertion whose expected text is final: what the oracle compares against. A DOM check
// is decided on what the driver's probe read of the element's classes, style or attribute.
export type ResolvedElementAssertion = ElementAssertionWith<SafeText>;

export const PageTextKind = {
  UrlPath: 'urlPath',
  Title: 'title',
} as const;
export type PageTextKind = (typeof PageTextKind)[keyof typeof PageTextKind];
export const PAGE_TEXT_KINDS: readonly PageTextKind[] = Object.values(PageTextKind);
export const PageAssertionKind = {
  ...PageTextKind,
  Url: 'url',
  UrlPathStartsWith: 'urlPathStartsWith',
  MetaContent: 'metaContent',
  CanonicalUrl: 'canonicalUrl',
} as const;
export type PageAssertionKind = (typeof PageAssertionKind)[keyof typeof PageAssertionKind];
export type PageAssertion =
  | { readonly kind: PageTextKind; readonly value: SafeText }
  // The whole URL, compared after resolving it against the page's own URL.
  | { readonly kind: typeof PageAssertionKind.Url; readonly value: AllowedUrl }
  // The page's path starts with this text, which starts with "/". A plain text prefix.
  | { readonly kind: typeof PageAssertionKind.UrlPathStartsWith; readonly value: SafeText }
  // The content of the <meta> whose name or property is `name`, such as "og:title".
  | { readonly kind: typeof PageAssertionKind.MetaContent; readonly name: SafeText; readonly value: TextOrValue }
  // The resolved href of <link rel="canonical">. It may name any origin: it is compared, never visited.
  | { readonly kind: typeof PageAssertionKind.CanonicalUrl; readonly value: SafeText };

// ---- Downloads ------------------------------------------------------------------------------

// The name a download step gives the file it starts, such as "project-list": lowercase letters,
// digits and hyphens. It is the plan's handle on the file, never a path: the driver stores the
// file under a name it generates.
export type DownloadName = Brand<string, 'DownloadName'>;
// Checks on a downloaded file. Sizes are in bytes. The content checks read the file as UTF-8
// text, and an empty file fails them, so contentExcludes cannot pass on nothing.
export const DownloadTextKind = {
  FileNameEquals: 'fileNameEquals',
  ContentContains: 'contentContains',
  ContentExcludes: 'contentExcludes',
} as const;
export type DownloadTextKind = (typeof DownloadTextKind)[keyof typeof DownloadTextKind];
export const DOWNLOAD_TEXT_KINDS: readonly DownloadTextKind[] = Object.values(DownloadTextKind);
export const DownloadSizeKind = {
  SizeAtMost: 'sizeAtMost',
  SizeAtLeast: 'sizeAtLeast',
} as const;
export type DownloadSizeKind = (typeof DownloadSizeKind)[keyof typeof DownloadSizeKind];
export const DOWNLOAD_SIZE_KINDS: readonly DownloadSizeKind[] = Object.values(DownloadSizeKind);
export const DownloadAssertionKind = {
  ...DownloadTextKind,
  MediaTypeEquals: 'mediaTypeEquals',
  ...DownloadSizeKind,
} as const;
export type DownloadAssertionKind = (typeof DownloadAssertionKind)[keyof typeof DownloadAssertionKind];
export type DownloadAssertion =
  | { readonly kind: DownloadTextKind; readonly value: TextOrValue }
  | { readonly kind: typeof DownloadAssertionKind.MediaTypeEquals; readonly value: SafeText }
  // sizeAtLeast is at least 1: a size of at least 0 holds for any file.
  | { readonly kind: DownloadSizeKind; readonly value: number };

// A URL path, or an absolute URL whose origin is on the project's allow-list.
export type AllowedUrl = Brand<string, 'AllowedUrl'>;
export type CaptureName = Brand<string, 'CaptureName'>;
export type FeatureId = Brand<string, 'FeatureId'>;
// The id of the acceptance criterion an assertion checks, from the user's own spec, such as "AC-3".
export type CriterionId = Brand<string, 'CriterionId'>;
// A file the trusted project declares in its fixtures list, which an upload step may send.
export type FixtureName = Brand<string, 'FixtureName'>;
// The name of a secret the trusted project declares. A plan names a secret; it never holds one.
export type SecretName = Brand<string, 'SecretName'>;
export type SecretReference = { readonly secretName: SecretName };

// Text of several lines for a fill, joined with line feeds and inserted as text, with no Enter
// key press, so a chat box does not send early.
export type MultiLineText = { readonly lines: readonly TextOrValue[] };
// A path on the run's base URL, built from literal and value segments plus query values. Each
// value is percent-encoded as one whole segment or query value, so no value can change the
// origin or the number of segments. Literal segments hold no "/", "?" or "#", and are never "."
// or ".."; query keys are letters, digits, "_", "." and "-".
export type PathTemplate = {
  readonly segments: readonly TextOrValue[];
  readonly query?: Readonly<Record<string, TextOrValue>>;
};
// Where a remember step reads its value: one element's visible text or its input value, one of its
// attributes by lowercase name (a DOM check, so an unsafe feature), a field of the latest response
// a declared request check saw, as text or as an array's length, or the plain text of the run's
// own clipboard.
export const RememberRead = {
  Text: 'text',
  Value: 'value',
} as const;
export type RememberRead = (typeof RememberRead)[keyof typeof RememberRead];
export const REMEMBER_READS: readonly RememberRead[] = Object.values(RememberRead);
export const RememberElementRead = {
  ...RememberRead,
  Attribute: 'attribute',
} as const;
export type RememberElementRead = (typeof RememberElementRead)[keyof typeof RememberElementRead];
export const REMEMBER_ATTRIBUTE_READ = RememberElementRead.Attribute;
export type RememberSource =
  | { readonly element: Locator; readonly read: RememberRead }
  | { readonly element: Locator; readonly read: typeof RememberElementRead.Attribute; readonly attribute: SafeText }
  | { readonly response: RequestName; readonly field: FieldName; readonly read: ResponseRead }
  | { readonly clipboard: ClipboardRead };

// How a navigate step may load the page. "disabled" turns script execution off until the next
// navigate, so the checks see what the server sent: nothing runs in the page, not even the
// determinism script.
export const ScriptMode = {
  Disabled: 'disabled',
} as const;
export type ScriptMode = (typeof ScriptMode)[keyof typeof ScriptMode];
export const SCRIPT_MODES: readonly ScriptMode[] = Object.values(ScriptMode);

export const DialogAction = {
  Accept: 'accept',
  Dismiss: 'dismiss',
} as const;
export type DialogAction = (typeof DialogAction)[keyof typeof DialogAction];
export const DIALOG_ACTIONS: readonly DialogAction[] = Object.values(DialogAction);

export const AuditMode = {
  Report: 'report',
  Gate: 'gate',
} as const;
export type AuditMode = (typeof AuditMode)[keyof typeof AuditMode];
export const AUDIT_MODES: readonly AuditMode[] = Object.values(AuditMode);

export const StepType = {
  Navigate: 'navigate',
  Click: 'click',
  Download: 'download',
  Hover: 'hover',
  Fill: 'fill',
  Select: 'select',
  Upload: 'upload',
  Press: 'press',
  Frame: 'frame',
  Dialog: 'dialog',
  Expect: 'expect',
  ExpectPage: 'expectPage',
  ExpectDownload: 'expectDownload',
  NewTab: 'newTab',
  A11yAudit: 'a11yAudit',
  Capture: 'capture',
  Remember: 'remember',
  Call: 'call',
  ExpectBackend: 'expectBackend',
  Stub: 'stub',
  ResetRequests: 'resetRequests',
  ExpectRequests: 'expectRequests',
  ExpectResponse: 'expectResponse',
  SetStorage: 'setStorage',
  RemoveStorage: 'removeStorage',
  ExpectStorage: 'expectStorage',
  AdvanceClock: 'advanceClock',
  ExpectClipboard: 'expectClipboard',
  Evaluate: 'evaluate',
  ExpectScript: 'expectScript',
  Database: 'database',
  ExpectDatabase: 'expectDatabase',
} as const;
export type StepType = (typeof StepType)[keyof typeof StepType];

export type Step =
  // A URL, or a path template on the run's base URL.
  | { readonly type: typeof StepType.Navigate; readonly url: AllowedUrl | PathTemplate; readonly scripts?: ScriptMode }
  | { readonly type: typeof StepType.Click; readonly locator: Locator }
  // A click that must start exactly one download, which later steps check by its name.
  | { readonly type: typeof StepType.Download; readonly name: DownloadName; readonly locator: Locator }
  | { readonly type: typeof StepType.Hover; readonly locator: Locator }
  | { readonly type: typeof StepType.Fill; readonly locator: Locator; readonly value: TextOrValue | SecretReference | MultiLineText }
  | { readonly type: typeof StepType.Select; readonly locator: Locator; readonly option: TextOrValue }
  | { readonly type: typeof StepType.Upload; readonly locator: Locator; readonly fixture: FixtureName }
  // Modifiers, when given, are 1 to 4 distinct keys held down while the key is pressed.
  | { readonly type: typeof StepType.Press; readonly locator: Locator; readonly key: Key; readonly modifiers?: readonly Modifier[] }
  // Runs its steps inside the iframe the locator finds.
  | { readonly type: typeof StepType.Frame; readonly locator: Locator; readonly steps: readonly Step[] }
  // Answers the next dialog the page opens, optionally checking its text first.
  | { readonly type: typeof StepType.Dialog; readonly action: DialogAction; readonly expectText?: TextOrValue }
  | { readonly type: typeof StepType.Expect; readonly locator: Locator; readonly assert: ElementAssertion; readonly criterionId: CriterionId }
  | { readonly type: typeof StepType.ExpectPage; readonly assert: PageAssertion; readonly criterionId: CriterionId }
  // Checks the file an earlier download step started.
  | { readonly type: typeof StepType.ExpectDownload; readonly download: DownloadName; readonly assert: DownloadAssertion; readonly criterionId: CriterionId }
  // Opens a URL in a new tab of the same browser context, so cookies and storage are shared, runs
  // its steps there and closes the tab. Only the top level of a plan may hold one.
  | { readonly type: typeof StepType.NewTab; readonly url: AllowedUrl | PathTemplate; readonly steps: readonly Step[] }
  | { readonly type: typeof StepType.A11yAudit; readonly mode: AuditMode }
  | { readonly type: typeof StepType.Capture; readonly name: CaptureName }
  // Reads a value from the page under `name`, for the steps after it to use.
  | { readonly type: typeof StepType.Remember; readonly name: ValueName; readonly from: RememberSource }
  // Makes a call the trusted project declares, by name, and may remember response fields as run
  // values for the steps after it. Only the plan's own list of steps, or its cleanup, may hold one.
  | { readonly type: typeof StepType.Call; readonly call: CallName; readonly arguments: CallArguments; readonly remember?: Readonly<Record<ValueName, FieldName>> }
  // Makes a declared read call and checks one field of its response, repeating the call while the
  // service answers with a status the declaration lists and the check has not passed, until the
  // project's backend check timeout runs out. A call that fails is not sent again.
  | {
    readonly type: typeof StepType.ExpectBackend; readonly call: CallName; readonly arguments: CallArguments; readonly field: FieldName;
    readonly assert: BackendAssertion; readonly criterionId: CriterionId;
  }
  // Starts or stops a stub, resets or checks the requests a declared matcher sees, checks the
  // latest response, and writes, removes or checks a declared storage entry, each only by the name
  // the trusted project gives it. See network-and-storage.ts.
  | NetworkAndStorageStep
  // Moves the run's virtual clock forward, or checks the clipboard's text. See clock-and-clipboard.ts.
  | ClockAndClipboardStep
  // Runs a page script or a database command the trusted project declares, or checks a field of
  // what one returns: unsafe features. See unsafe-plan-features.ts.
  | PageScriptStep
  | DatabaseCommandStep;
// The steps that send input to the page; the driver's ActionRunner port performs them, asking the
// policy gate's runtime guard first. All but a dialog act on an element; answering a dialog acts
// on the dialog the page opened, so the guard reads its text. The policy gate judges a download as
// the click it is.
export type ActionStep = Extract<Step, { type: typeof StepType.Click | typeof StepType.Hover | typeof StepType.Fill | typeof StepType.Select | typeof StepType.Upload | typeof StepType.Press | typeof StepType.Download | typeof StepType.Dialog }>;
// Accepts or dismisses the next dialog the page opens.
export type DialogStep = Extract<Step, { type: typeof StepType.Dialog }>;
// A click that must start exactly one download, which the driver's download port performs.
export type DownloadStep = Extract<Step, { type: typeof StepType.Download }>;
// Lines of a multi-line fill with every value reference replaced by its text.
export type ResolvedMultiLineText = { readonly lines: readonly SafeText[] };
// An action step with every value reference replaced by its text, as the engine hands it to a
// driver.
export type ResolvedActionStep =
  | { readonly type: typeof StepType.Click; readonly locator: ResolvedLocator }
  | { readonly type: typeof StepType.Hover; readonly locator: ResolvedLocator }
  | { readonly type: typeof StepType.Fill; readonly locator: ResolvedLocator; readonly value: SafeText | SecretReference | ResolvedMultiLineText }
  | { readonly type: typeof StepType.Select; readonly locator: ResolvedLocator; readonly option: SafeText }
  | { readonly type: typeof StepType.Upload; readonly locator: ResolvedLocator; readonly fixture: FixtureName }
  | { readonly type: typeof StepType.Press; readonly locator: ResolvedLocator; readonly key: Key; readonly modifiers?: readonly Modifier[] };
// A step that calls a declared service.
export type CallStep = Extract<Step, { type: typeof StepType.Call }>;
// What a plan's cleanup list holds: calls and database commands.
export type CleanupStep = CallStep | DatabaseStep;
export type ServiceCallStep = Extract<Step, { type: typeof StepType.Call | typeof StepType.ExpectBackend }>;

export type PlanMeta = { readonly featureId: FeatureId; readonly specReference: SafeText; readonly title: SafeText };

export type PlanData = {
  readonly version: `${number}.${number}`;
  readonly meta: PlanMeta;
  readonly targets: readonly TargetId[];
  readonly steps: readonly Step[];
  // Saved browser storage state (cookies and local storage) to start the session with. It is a
  // secret a person exported, so the plan names it and the secret store holds the JSON.
  readonly storageState?: SecretReference;
  // Values generated for each run, by name. Every step may use them.
  readonly values?: Readonly<Record<string, GeneratedValue>>;
  // The page's frozen clock, relative to the run's clock start. Absent: the run's clock start.
  readonly clock?: PlanClock;
  // Calls, and database commands, run in order after the steps, whatever the outcome, such as
  // deleting the test data the steps created.
  readonly cleanup?: readonly CleanupStep[];
};
export type Plan = Brand<PlanData, 'Plan'>;
