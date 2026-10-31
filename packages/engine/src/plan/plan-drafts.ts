// The one door from a draft to a Plan, for every authoring route. admitDraft reads the draft (text
// through the readable plan reader, JSON as JSON), calls the plan parser it is given exactly once,
// returns the parser's own Plan, and appends one plan.submitted or plan.rejected audit event with
// the draft's provenance. Nothing else is called before that parse.
//
// Provenance is recorded and never trusted. A draft that declares none is hand-written, basis
// declared. A caller may declare hand-written or customer-llm; a claim that core produced the
// draft is refused with untrusted-source before the parser, since only core's own routes record
// that basis. Core's own routes admit their drafts through admitCoreDraft, which records the route
// as the source, basis core-recorded, under an actor of the engine's choosing.
// See docs/specs/SPEC-28-plan-authoring.md.
import {
  DECLARABLE_PLAN_SOURCES, failure, success,
  type DerivedActor, type EventSink, type Plan, type PlanDraft, type PlanProvenance, type PlanSource, type Result,
} from '@revisum/contracts';
import { deriveActor, sourceActorId } from '../actor.ts';
import { planHash } from '../manifest.ts';
import { LIMIT_CEILINGS } from '../project/project-parser.ts';
import { isUnsafeText, type PlanError } from './plan-decoders.ts';
import { placedPlanErrors, readPlanText, type DraftError, type TextPosition } from './readable/plan-text.ts';
import { isRecord } from './readable/text-syntax.ts';

// What planParser(project) returns.
export type PlanParse = (input: unknown) => Result<Plan, readonly PlanError[]>;

const HAND_WRITTEN: PlanProvenance = { source: 'hand-written', basis: 'declared' };
const PROVENANCE_FIELDS = ['source', 'basis', 'reference'];
// A spec path, issue id or session id, never content, so it is short.
const MAXIMUM_REFERENCE_LENGTH = 200;

// A reference is a spec path, issue id or session id: short, plain text.
const usableReference = (reference: string): boolean =>
  reference !== '' && reference.length <= MAXIMUM_REFERENCE_LENGTH && !isUnsafeText(reference);

// The provenance to record for what a draft declares, or undefined when it may not declare it.
function declaredProvenance(declared: unknown): PlanProvenance | undefined {
  if (declared === undefined) return HAND_WRITTEN;
  if (!isRecord(declared) || Object.keys(declared).some((key) => !PROVENANCE_FIELDS.includes(key))) return undefined;
  const source = DECLARABLE_PLAN_SOURCES.find((candidate) => candidate === declared['source']);
  if (source === undefined || declared['basis'] !== 'declared') return undefined;
  const reference = declared['reference'];
  if (reference === undefined) return { source, basis: 'declared' };
  return typeof reference === 'string' && usableReference(reference) ? { source, basis: 'declared', reference } : undefined;
}

type DraftInput = { readonly json: unknown; readonly positions: ReadonlyMap<string, TextPosition> | null };

// The plain JSON a draft holds, for the parser. Text is read against the largest plan any project
// may allow; the parser then holds the plan to its own project's limit.
function draftInput(draft: PlanDraft): Result<DraftInput, readonly DraftError[]> {
  if (draft.format === 'text') {
    const read = readPlanText(draft.content, LIMIT_CEILINGS);
    return read.ok ? success({ json: read.value.json, positions: read.value.positions }) : read;
  }
  if (new TextEncoder().encode(draft.content).length > LIMIT_CEILINGS.maximumPlanBytes) {
    return failure([{ stage: 'plan', code: 'too_large', path: '$', position: null }]);
  }
  try {
    return success({ json: JSON.parse(draft.content), positions: null });
  } catch {
    // Text that is not JSON at all holds no plan object.
    return failure([{ stage: 'plan', code: 'not_object', path: '$', position: null }]);
  }
}

export function admitDraft(draft: PlanDraft, parsePlan: PlanParse, events: EventSink, actor: DerivedActor): Result<Plan, readonly DraftError[]> {
  const provenance = declaredProvenance(draft.provenance);
  if (provenance === undefined) {
    // The claim is exactly what is not trusted, so it is not recorded as the draft's provenance.
    events.append({ kind: 'plan.rejected' }, actor);
    return failure([{ stage: 'source', code: 'untrusted-source', position: null }]);
  }
  return admitWithProvenance(draft, provenance, parsePlan, events, actor);
}

// The sources only core's own routes record: every source an author may not declare.
export type CoreRouteSource = Exclude<PlanSource, (typeof DECLARABLE_PLAN_SOURCES)[number]>;
// The core route a draft came by, and what it drafted from, such as the spec's path.
export type CoreRoute = { readonly source: CoreRouteSource; readonly reference?: string };

// Admits a draft one of core's own routes produced, such as the draft command's. The route, not
// the draft, says where it came from: any provenance the draft carries is ignored, and the source
// is recorded with basis core-recorded. A reference that is not short plain text is left out. The
// actor is the route itself, an agent, since a route drafts by machine and no person stands
// behind the draft until one approves it.
export function admitCoreDraft(draft: PlanDraft, route: CoreRoute, parsePlan: PlanParse, events: EventSink): Result<Plan, readonly DraftError[]> {
  const provenance: PlanProvenance = {
    source: route.source, basis: 'core-recorded',
    ...(route.reference !== undefined && usableReference(route.reference) ? { reference: route.reference } : {}),
  };
  return admitWithProvenance(draft, provenance, parsePlan, events, deriveActor(sourceActorId(`${route.source} route`), 'agent'));
}

function admitWithProvenance(
  draft: PlanDraft, provenance: PlanProvenance, parsePlan: PlanParse, events: EventSink, actor: DerivedActor,
): Result<Plan, readonly DraftError[]> {
  const reject = (errors: readonly DraftError[]): Result<Plan, readonly DraftError[]> => {
    events.append({ kind: 'plan.rejected', planProvenance: provenance }, actor);
    return failure(errors);
  };
  const input = draftInput(draft);
  if (!input.ok) return reject(input.error);
  const parsed = parsePlan(input.value.json);
  if (!parsed.ok) return reject(placedPlanErrors(parsed.error, input.value.positions));
  const recorded = events.append({ kind: 'plan.submitted', subjectHash: planHash(parsed.value), planProvenance: provenance }, actor);
  // A submission the audit sink did not record is not admitted.
  if (!recorded.ok) return failure([{ stage: 'audit', code: recorded.error.code, position: null }]);
  return success(parsed.value);
}
