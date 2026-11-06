// Database commands, which run in a workload container through the run's port, not in the browser.
// A run that runs them always has a runner: preflight refused it before any step otherwise.
import {
    runDatabaseCheck,
    runDatabaseStep,
} from "../../../database-commands/database-command-steps.ts";
import type { StepExecutorTable } from "../StepExecutor.ts";

export const DATABASE_COMMAND_EXECUTORS: Pick<StepExecutorTable, "database" | "expectDatabase"> = {
    database: (step, context) => runDatabaseStep(step, context.index, context.commands),
    expectDatabase: (step, context) => runDatabaseCheck(step, context.index, context.commands),
};
