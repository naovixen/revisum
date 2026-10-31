// Public entry point: the composition root. It runs a declared suite in evidence mode, wires
// database commands to the workload runner and runs the draft command; the rest of the command
// line is SPEC-16's.
export { runSuite, type SuiteRunPorts } from './suite-run.ts';
export { databaseCommandRunner, type DatabaseCommandRunnerOptions } from './database-commands.ts';
export {
  draftCommand, type DraftCommandData, type DraftCommandPorts, type DraftCommandResult,
} from './draft-command.ts';
export { isLoopbackEndpoint, plannerAdapter, PlannerCallError, type PlannerCallFailure, type PlannerConnection } from './planner-adapters.ts';
export { CLI_OUTPUT_SCHEMA, cliError, exitCodeFor, type CliError, type CliOutput, type Command, type CommandOutcome } from './cli-output.ts';
