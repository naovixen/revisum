// Release notes from a run. The draft is deterministic and uses no AI: the same plan and results
// always give the same bytes. An AI may only add a suggestion stored beside the draft, never
// replace it, and never containing typed or expected values.
import {
  literalText, referencedValueName,
  type AiWriter, type ArtifactReference, type ArtifactStore, type Locator, type Plan, type RememberSource, type REQUEST_COUNT_KINDS, type RequestCount,
  type ResponseAssertion, type Step, type StorageAssertion, type TextOrValue,
} from '@revisum/contracts';
import { parseAiText } from './ai-text.ts';
import type { PlanErrorCode } from './plan/plan-decoders.ts';
import type { RunResult } from './run.ts';

const MARKDOWN_SPECIAL = /[\\`*_[\]<>#|!()]/g;
// Markdown-safe text: every character with a Markdown meaning gets a backslash.
export const markdownEscape = (text: string): string => text.replace(MARKDOWN_SPECIAL, (character) => `\\${character}`);
// Text for inside a code span, where backslash escapes do not apply.
const codeSpanText = (text: string): string => text.replace(/`/g, "'");

const ASSERTION_TEXT: { readonly [Kind in Extract<Step, { type: 'expect' }>['assert']['kind']]: string } = {
  visible: 'is visible', hidden: 'is hidden', enabled: 'is enabled', disabled: 'is disabled',
  textEquals: 'has the expected text', textContains: 'contains the expected text', valueEquals: 'has the expected value',
  valueContains: 'contains the expected value', absent: 'is absent', checked: 'is checked', unchecked: 'is not checked',
  focused: 'has focus', countEquals: 'matches the expected number of times',
  selected: 'is selected', unselected: 'is not selected', expanded: 'is expanded', collapsed: 'is collapsed',
  pressed: 'is pressed', unpressed: 'is not pressed', current: 'is marked as current', hrefEquals: 'links to the expected address',
};
const PAGE_ASSERTION_TEXT: { readonly [Kind in Extract<Step, { type: 'expectPage' }>['assert']['kind']]: string } = {
  title: 'title', urlPath: 'URL path', url: 'URL', urlPathStartsWith: 'URL path prefix',
  metaContent: 'meta tag', canonicalUrl: 'canonical URL',
};
const BACKEND_ASSERTION_TEXT: { readonly [Kind in Extract<Step, { type: 'expectBackend' }>['assert']['kind']]: string } = {
  present: 'is present', absent: 'is absent', equals: 'has the expected text', contains: 'contains the expected text',
  numberEquals: 'has the expected number',
};
const DOWNLOAD_ASSERTION_TEXT: { readonly [Kind in Extract<Step, { type: 'expectDownload' }>['assert']['kind']]: string } = {
  fileNameEquals: 'file name', mediaTypeEquals: 'media type', sizeAtMost: 'largest size', sizeAtLeast: 'smallest size',
  contentContains: 'expected content', contentExcludes: 'excluded content',
};

// A value reference is shown by its name: the value itself is run data, not plan text.
const plainText = (text: TextOrValue): string => literalText(text) ?? `{${referencedValueName(text) ?? ''}}`;

function describeLocator(locator: Locator): string {
  switch (locator.by) {
    case 'role': return `the "${markdownEscape(plainText(locator.name))}" ${locator.role}`;
    case 'label': return `the "${markdownEscape(plainText(locator.label))}" field`;
    case 'text': return `the text "${markdownEscape(plainText(locator.text))}"`;
    case 'testId': return `the \`${codeSpanText(plainText(locator.testId))}\` element`;
  }
}

// Where a navigate step goes: its path, or a path template's segments with values by name.
function describeNavigation(url: Extract<Step, { type: 'navigate' }>['url']): string {
  if (typeof url === 'string') return new URL(url, 'http://relative.invalid').pathname;
  return `/${url.segments.map(plainText).join('/')}`;
}

// One plain-English line per step. Values typed or expected are never included.
export function describeStep(step: Step): string {
  switch (step.type) {
    case 'navigate': return `Opened \`${codeSpanText(describeNavigation(step.url))}\`${step.scripts === 'disabled' ? ' with scripts off' : ''}`;
    case 'click': return `Clicked ${describeLocator(step.locator)}`;
    case 'download': return `Downloaded a file from ${describeLocator(step.locator)} as "${step.name}"`;
    case 'hover': return `Hovered over ${describeLocator(step.locator)}`;
    case 'fill': return `Filled in ${describeLocator(step.locator)}`;
    case 'select': return `Chose an option in ${describeLocator(step.locator)}`;
    case 'upload': return `Uploaded a fixture file to ${describeLocator(step.locator)}`;
    case 'press': return `Pressed ${[...(step.modifiers ?? []), step.key].join('+')} on ${describeLocator(step.locator)}`;
    case 'frame': return `Inside ${describeLocator(step.locator)}: ${step.steps.map(describeStep).join('; ')}`;
    case 'dialog': return `${step.action === 'accept' ? 'Accepted' : 'Dismissed'} the next dialog`;
    case 'expect': return `Checked that ${describeLocator(step.locator)} ${ASSERTION_TEXT[step.assert.kind]}`;
    case 'expectPage': return `Checked the page ${PAGE_ASSERTION_TEXT[step.assert.kind]}`;
    case 'expectDownload': return `Checked the ${DOWNLOAD_ASSERTION_TEXT[step.assert.kind]} of download "${step.download}"`;
    case 'newTab': return `In a new tab at \`${codeSpanText(describeNavigation(step.url))}\`: ${step.steps.map(describeStep).join('; ')}`;
    case 'a11yAudit': return `Ran automated accessibility rules (${step.mode} mode)`;
    case 'capture': return `Captured screenshot "${step.name}"`;
    case 'call': return `Called the declared \`${codeSpanText(step.call)}\` service call`;
    case 'expectBackend': return `Checked that field "${markdownEscape(step.field)}" of \`${codeSpanText(step.call)}\` ${BACKEND_ASSERTION_TEXT[step.assert.kind]}`;
    case 'remember': return `Remembered ${describeRememberSource(step.from)} as {${step.name}}`;
    case 'stub': return `${step.action === 'start' ? 'Started' : 'Stopped'} the declared \`${codeSpanText(step.stub)}\` stub`;
    case 'resetRequests': return `Reset the count of \`${codeSpanText(step.request)}\` requests`;
    case 'expectRequests': return `Checked ${REQUEST_COUNT_TEXT[requestCountKind(step.count)]} of \`${codeSpanText(step.request)}\` requests`;
    case 'expectResponse': return `Checked that the latest \`${codeSpanText(step.request)}\` response ${describeResponseAssertion(step.assert)}`;
    case 'setStorage': return `Wrote the declared \`${codeSpanText(step.entry)}\` storage entry`;
    case 'removeStorage': return `Removed the declared \`${codeSpanText(step.entry)}\` storage entry`;
    case 'expectStorage': return `Checked that the \`${codeSpanText(step.entry)}\` storage entry ${STORAGE_ASSERTION_TEXT[step.assert.kind]}`;
  }
}

function describeRememberSource(from: RememberSource): string {
  if ('element' in from) return `${from.read === 'text' ? 'the text' : 'the value'} of ${describeLocator(from.element)}`;
  const field = `field "${markdownEscape(from.field)}" of the latest \`${codeSpanText(from.response)}\` response`;
  return from.read === 'text' ? field : `the length of ${field}`;
}

const REQUEST_COUNT_TEXT: { readonly [Kind in (typeof REQUEST_COUNT_KINDS)[number]]: string } = {
  equals: 'the exact number', atLeast: 'the least number', atMost: 'the greatest number',
};
const requestCountKind = (count: RequestCount): (typeof REQUEST_COUNT_KINDS)[number] =>
  ('equals' in count ? 'equals' : 'atLeast' in count ? 'atLeast' : 'atMost');

function describeResponseAssertion(assertion: ResponseAssertion): string {
  switch (assertion.kind) {
    case 'statusEquals': return 'has the expected status';
    case 'fieldPresent': return `has field "${markdownEscape(assertion.field)}"`;
    case 'fieldAbsent': return `has no field "${markdownEscape(assertion.field)}"`;
    case 'fieldEquals': return `has the expected text in field "${markdownEscape(assertion.field)}"`;
    case 'fieldContains': return `contains the expected text in field "${markdownEscape(assertion.field)}"`;
  }
}

const STORAGE_ASSERTION_TEXT: { readonly [Kind in StorageAssertion['kind']]: string } = {
  present: 'is present', absent: 'is absent', equals: 'has the expected value',
};

export function releaseNoteDraft(plan: Plan, results: readonly RunResult[]): string {
  const lines: string[] = [
    `## ${markdownEscape(plan.meta.title)} (${markdownEscape(plan.meta.featureId)})`,
    '',
    `Spec: \`${codeSpanText(plan.meta.specReference)}\``,
    '',
    '### Verified on',
    '',
    '| Target | Browser | Device | Locale | Time zone | Result | Steps passed |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const result of results) {
    const manifest = result.manifest;
    const passed = result.steps.filter((step) => step.outcome === 'passed').length;
    lines.push(manifest === null
      ? `| ${result.targetId} | - | - | - | - | ${result.state}: ${result.unavailable?.reason ?? ''} | 0 of ${plan.steps.length} |`
      : `| ${result.targetId} | ${manifest.browser.name} ${manifest.browser.version} | ${manifest.target.device} | ${manifest.target.locale} | ${manifest.target.timezone} | ${result.state} | ${passed} of ${plan.steps.length} |`);
  }
  lines.push('', '### What was checked', '', ...plan.steps.map((step, index) => `${index + 1}. ${describeStep(step)}`));

  const screenshots = results.flatMap((result) => result.steps.flatMap((step) => (step.artifact ? [step.artifact] : [])));
  if (screenshots.length > 0) {
    lines.push('', '### Screenshots', '', ...screenshots.map((artifact) => `- \`${artifact.name}\` (sha256 ${artifact.sha256.slice(0, 12)})`));
  }

  const audits = results.flatMap((result) => result.steps.flatMap((step) => (step.findings ? [{ target: result.targetId, findings: step.findings }] : [])));
  if (audits.length > 0) {
    lines.push('', '### Accessibility (automated rules only)', '');
    for (const audit of audits) {
      const listed = audit.findings
        .map((finding) => `${finding.ruleId} (${finding.impact}, ${finding.elementCount} element${finding.elementCount === 1 ? '' : 's'})`)
        .join(', ');
      lines.push(`- ${audit.target}: ${audit.findings.length === 0 ? 'no rule violations found' : listed}`);
    }
    lines.push('', 'Automated rules cover only part of WCAG 2.2 AA. This is not a conformance claim.');
  }

  lines.push('', '### Provenance', '', ...results.map((result) => `- ${result.targetId}: manifest ${result.manifestHash?.slice(0, 16) ?? 'none'}, result ${result.resultHash.slice(0, 16)}`));
  lines.push('', '_Draft generated deterministically from the plan and the run results. No AI was used._', '');
  return lines.join('\n');
}

const MAXIMUM_SUGGESTION_LENGTH = 20_000;
// Why a suggestion was refused, in the words the release artefacts have always used.
const REJECTION_REASONS: Partial<Readonly<Record<PlanErrorCode, string>>> = {
  wrong_type: 'not-text', empty: 'empty', too_long: 'too-long', unsafe_text: 'unsafe-text',
};

export type ReleaseArtefacts = {
  readonly draft: ArtifactReference;
  readonly suggestion: ArtifactReference | null;
  readonly suggestionRejected: string | null;
};

// Stores the deterministic draft, then optionally an AI suggestion beside it, never instead of it.
export async function writeReleaseNotes(
  plan: Plan, results: readonly RunResult[], store: ArtifactStore, writer?: AiWriter,
): Promise<ReleaseArtefacts> {
  const text = releaseNoteDraft(plan, results);
  const draft = await store.put('release-notes.md', new TextEncoder().encode(text), 'text/markdown');
  if (writer === undefined) return { draft, suggestion: null, suggestionRejected: null };
  let proposal: unknown;
  try { proposal = await writer.suggest(text); } catch { return { draft, suggestion: null, suggestionRejected: 'writer-error' }; }
  // The suggestion is outside input: it is parsed before anything is stored, and stored only if it passes.
  const parsed = parseAiText(proposal, MAXIMUM_SUGGESTION_LENGTH);
  if (!parsed.ok) return { draft, suggestion: null, suggestionRejected: REJECTION_REASONS[parsed.error.code] ?? parsed.error.code };
  const banner = `<!-- AI suggestion, not reviewed. The source of truth is release-notes.md (sha256 ${draft.sha256}). -->\n`;
  const suggestion = await store.put('release-notes.suggestion.md', new TextEncoder().encode(banner + parsed.value), 'text/markdown');
  return { draft, suggestion, suggestionRejected: null };
}
