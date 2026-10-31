// Reads a spec's acceptance criteria from its Markdown, the only part of a spec the draft command
// sends to a planner. The rule is fixed and deterministic: the items under the first heading named
// "Acceptance criteria", each written "- <criterion id>: <text>" on one line, until the next
// heading. Everything else in the spec (background, notes, links to screenshots) is never read
// into a criterion, so it can never reach a planner.
// See docs/specs/SPEC-28-plan-authoring.md.
import { failure, success, type CriterionText, type Result } from '@revisum/contracts';
import { criterionIdFrom } from '../plan/plan-parser.ts';

const HEADING = /^#{1,6}\s/;
const CRITERIA_HEADING = /^#{1,6}\s+acceptance criteria\s*#*\s*$/i;
// "- AC-1: text" or "* AC-1: text".
const CRITERION_ITEM = /^\s*[-*]\s+([^\s:]+):\s+(\S.*)$/;
// A criterion is one line of a spec, so a far longer one is not a criterion at all.
const MAXIMUM_CRITERION_LENGTH = 2000;

export type CriteriaError = { readonly code: 'no-criteria' };

export function extractCriteria(markdown: string): Result<readonly CriterionText[], CriteriaError> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => CRITERIA_HEADING.test(line));
  if (start === -1) return failure({ code: 'no-criteria' });
  const criteria: CriterionText[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    const item = CRITERION_ITEM.exec(line);
    if (item === null) continue;
    const criterion = criterionIdFrom(item[1] ?? '');
    const text = (item[2] ?? '').trim();
    if (criterion === undefined || text.length > MAXIMUM_CRITERION_LENGTH) continue;
    criteria.push({ criterion, text });
  }
  return criteria.length === 0 ? failure({ code: 'no-criteria' }) : success(criteria);
}
