/// <reference lib="dom" />
// The Playwright driver's audit step: axe-core, injected unmodified as one bundle. A driver may
// import only contracts, so this mirrors the injection in the auditor-axe package; both read the
// same pinned axe.min.js. See docs/decisions/browser-and-audit-dependencies.md.
import { IMPACTS, type A11yFinding } from '@revisum/contracts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);
export const AXE_SOURCE: string = readFileSync(requireFromHere.resolve('axe-core/axe.min.js'), 'utf8');

// WCAG 2.0, 2.1 and 2.2 level A and AA rule tags.
export const AXE_TAGS: readonly string[] = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type AxeInPage = {
  run(context: Document, options: unknown): Promise<{ violations: { id: string; impact?: string | null; nodes: unknown[] }[] }>;
};

// Runs in the page after AXE_SOURCE has been added. Returns the violations as JSON.
export async function runAxe(tags: readonly string[]): Promise<string> {
  const axe = (window as unknown as { axe: AxeInPage }).axe;
  const results = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
  return JSON.stringify(results.violations.map((violation) => ({ ruleId: violation.id, impact: violation.impact ?? 'unknown', nodes: violation.nodes.length })));
}

export function toFindings(json: string): readonly A11yFinding[] {
  const raw = JSON.parse(json) as { ruleId: string; impact: string; nodes: number }[];
  return raw.map((violation) => ({
    ruleId: violation.ruleId,
    impact: IMPACTS.find((impact) => impact === violation.impact) ?? 'unknown',
    elementCount: violation.nodes,
  }));
}
