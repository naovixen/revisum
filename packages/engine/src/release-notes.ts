// Release notes from a run. The draft is deterministic and uses no AI: the same plan and results
// always give the same bytes. An AI may only add a suggestion stored beside the draft, never
// replace it, and never containing typed or expected values.
import type { AiWriter, ArtifactReference, ArtifactStore, Locator, Plan, Step } from '@revisum/contracts';
import type { RunResult } from './run.ts';

const MARKDOWN_SPECIAL = /[\\`*_[\]<>#|!()]/g;
// Markdown-safe text: every character with a Markdown meaning gets a backslash.
export const markdownEscape = (text: string): string => text.replace(MARKDOWN_SPECIAL, (character) => `\\${character}`);
// Text for inside a code span, where backslash escapes do not apply.
const codeSpanText = (text: string): string => text.replace(/`/g, "'");

const ASSERTION_TEXT: { readonly [Kind in Extract<Step, { type: 'expect' }>['assert']['kind']]: string } = {
  visible: 'is visible', hidden: 'is hidden', enabled: 'is enabled', disabled: 'is disabled',
  textEquals: 'has the expected text', textContains: 'contains the expected text', valueEquals: 'has the expected value',
  valueContains: 'contains the expected value',
};

function describeLocator(locator: Locator): string {
  switch (locator.by) {
    case 'role': return `the "${markdownEscape(locator.name)}" ${locator.role}`;
    case 'label': return `the "${markdownEscape(locator.label)}" field`;
    case 'text': return `the text "${markdownEscape(locator.text)}"`;
    case 'testId': return `the \`${codeSpanText(locator.testId)}\` element`;
  }
}

// One plain-English line per step. Values typed or expected are never included.
export function describeStep(step: Step): string {
  switch (step.type) {
    case 'navigate': return `Opened \`${codeSpanText(new URL(step.url, 'http://relative.invalid').pathname)}\``;
    case 'click': return `Clicked ${describeLocator(step.locator)}`;
    case 'fill': return `Filled in ${describeLocator(step.locator)}`;
    case 'press': return `Pressed ${step.key} on ${describeLocator(step.locator)}`;
    case 'expect': return `Checked that ${describeLocator(step.locator)} ${ASSERTION_TEXT[step.assert.kind]}`;
    case 'expectPage': return `Checked the page ${step.assert.kind === 'title' ? 'title' : 'URL'}`;
    case 'a11yAudit': return `Ran automated accessibility rules (${step.mode} mode)`;
    case 'capture': return `Captured screenshot "${step.name}"`;
  }
}

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

const UNSAFE_SUGGESTION = [
  /<\s*\/?\s*(script|iframe|object|embed|style)\b/i,
  /\b(javascript|vbscript)\s*:/i,
  /\bon[a-z]+\s*=/i,
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]/,
];
const MAXIMUM_SUGGESTION_LENGTH = 20_000;

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
  if (typeof proposal !== 'string') return { draft, suggestion: null, suggestionRejected: 'not-text' };
  if (proposal.length > MAXIMUM_SUGGESTION_LENGTH) return { draft, suggestion: null, suggestionRejected: 'too-long' };
  if (UNSAFE_SUGGESTION.some((pattern) => pattern.test(proposal))) return { draft, suggestion: null, suggestionRejected: 'unsafe-text' };
  const banner = `<!-- AI suggestion, not reviewed. The source of truth is release-notes.md (sha256 ${draft.sha256}). -->\n`;
  const suggestion = await store.put('release-notes.suggestion.md', new TextEncoder().encode(banner + proposal), 'text/markdown');
  return { draft, suggestion, suggestionRejected: null };
}
