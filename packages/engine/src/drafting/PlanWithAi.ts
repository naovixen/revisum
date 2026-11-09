// AI containment at the planning boundary: a planner's output is unknown until the plan parser
// says otherwise. There is no other path from an AI to a Plan.
import type { AiPlanner, Plan, Result, SpecInput, PlanError } from '@revisum/contracts';
import { PlanErrorCode } from '@revisum/contracts';

export async function planWithAi(
  planner: AiPlanner,
  spec: SpecInput,
  parsePlan: (input: unknown) => Result<Plan, readonly PlanError[]>,
): Promise<Result<Plan, readonly PlanError[]>> {
  let proposal: unknown;
  try { proposal = await planner.propose(spec); } catch { return { ok: false, error: [{ code: PlanErrorCode.NotObject, path: '$' }] }; }
  return parsePlan(proposal);
}
