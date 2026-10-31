// Public entry point: the composition root. For now it runs a declared suite in evidence mode and
// wires database commands to the workload runner; the command line itself is SPEC-16's.
export { runSuite, type SuiteRunPorts } from './suite-run.ts';
export { databaseCommandRunner, type DatabaseCommandRunnerOptions } from './database-commands.ts';
