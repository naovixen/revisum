// Declared service calls, which go through the run's service caller. A run that calls services
// always has one: preflight refused it before any step otherwise.
import { runBackendCheck, runCallStep } from "../../../service-calls/call-steps.ts";
import type { StepExecutorTable } from "../StepExecutor.ts";

export const SERVICE_CALL_EXECUTORS: Pick<StepExecutorTable, "call" | "expectBackend"> = {
    call: (step, context) => runCallStep(step, context.index, context.calls),
    expectBackend: (step, context) => runBackendCheck(step, context.index, context.calls),
};
