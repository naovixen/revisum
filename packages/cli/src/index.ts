// Public entry point: the composition root. It runs a declared suite in evidence mode, wires
// database commands to the workload runner and runs the draft command, with its explore mode; the
// rest of the command line is not here. It also gathers a run's pins and makes the benchmark's runs.
export { runSuite, type SuiteRunPorts } from "./commands/RunSuite.ts";
export {
    databaseCommandRunner,
    type DatabaseCommandRunnerOptions,
} from "./commands/DatabaseCommandRunner.ts";
export {
    draftCommand,
    type DraftCommandData,
    type DraftCommandPorts,
    type DraftCommandResult,
    type PlannerCall,
    type PlannerCallOutcome,
} from "./commands/DraftCommand.ts";
export {
    CONTAINER_CRAWL_MODULE,
    crawlInBrowser,
    crawlInRunner,
    crawlTarget,
    type BrowserCrawl,
    type ContainerCrawlInput,
    type CrawlStop,
    type IsolatedRunner,
    type LoginOnItsSession,
    type LoginRunner,
} from "./explore/CrawlInBrowser.ts";
export {
    plannerAdapter,
    type PlannerAdapter,
    type PlannerCallFailure,
    type PlannerConnection,
} from "./planners/PlannerAdapter.ts";
export {
    CLI_OUTPUT_SCHEMA,
    cliError,
    exitCodeFor,
    type CliError,
    type CliOutput,
    type Command,
    type CommandOutcome,
} from "./output/CliOutput.ts";
export { runPins, type BaselineFile, type RunPinsOptions } from "./commands/RunPins.ts";
export {
    buildAdapters,
    type BenchmarkPorts,
    type ContainerCrawlPorts,
    type DraftCommandNeeds,
    type DraftCommandOverrides,
    type PlannerNetwork,
    type SuiteRunNeeds,
    type SuiteRunOverrides,
} from "./wiring/BuildAdapters.ts";
export {
    benchmarkRuns,
    type BenchmarkRuns,
    type BenchmarkRunsOptions,
    type BenchmarkSample,
} from "./commands/BenchmarkRuns.ts";
