// AI containment at the planning boundary: a planner's output is unknown until the plan parser
// says otherwise. There is no other path from an AI to a Plan.
import type { AiPlanner, Plan, Result, SpecInput } from '@revisum/contracts';
import type { PlanError } from './plan/plan-decoders.ts';

export async function planWithAi(
  planner: AiPlanner,
  spec: SpecInput,
  parsePlan: (input: unknown) => Result<Plan, readonly PlanError[]>,
): Promise<Result<Plan, readonly PlanError[]>> {
  let proposal: unknown;
  try { proposal = await planner.propose(spec); } catch { return { ok: false, error: [{ code: 'not_object', path: '$' }] }; }
  return parsePlan(proposal);
}
