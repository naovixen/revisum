// Page scripts, which run through the script port of the document the step stands in.
import {
    runEvaluate,
    runScriptCheck,
    type PageScriptContext,
} from "../../../page-scripts/page-script-steps.ts";
import type { RunContext } from "../../RunContext.ts";
import type { StepExecutorTable } from "../StepExecutor.ts";

// What the page-script steps use: the run's values and the scripts the plan names, with their sources.
const pageScriptContext = (context: RunContext): PageScriptContext => ({
    project: context.cleared.project,
    scripts: context.scripts,
    values: context.values,
    remembered: context.remembered,
    clock: context.ports.clock,
    logger: context.logger,
    holdsSecret: context.holdsSecret,
});

export const PAGE_SCRIPT_EXECUTORS: Pick<StepExecutorTable, "evaluate" | "expectScript"> = {
    evaluate: (step, context) =>
        runEvaluate(step, context.index, context.document, pageScriptContext(context)),
    expectScript: (step, context) =>
        runScriptCheck(step, context.index, context.document, pageScriptContext(context)),
};
