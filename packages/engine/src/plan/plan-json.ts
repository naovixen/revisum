// The canonical JSON file form of a plan. Its keys are in the same fixed order as the plan hash's
// input (canonicalJson: sorted keys), so the file does not depend on the key order or layout the
// plan was written in, and it is laid out with two-space indentation, LF line ends and a final
// newline. The plan hash stays the hash of canonicalJson itself, not of this file.
// See docs/specs/SPEC-28-plan-authoring.md.
import type { Plan } from '@revisum/contracts';
import { canonicalJson } from '../hashing.ts';

export const writePlanJson = (plan: Plan): string => `${JSON.stringify(JSON.parse(canonicalJson(plan)), null, 2)}\n`;
