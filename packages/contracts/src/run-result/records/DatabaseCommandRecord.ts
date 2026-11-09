import type { ServiceName } from "../../plan/steps/ServiceCaller.ts";
import type { CommandName } from "../../plan/steps/UnsafeFeaturesDeclaration.ts";

// What a run keeps of a database step: the command, its service, how many times it ran, and of
// its last run the exit code and the sha256 of what it printed on standard output (null when it
// did not run, or its output was cut short or held a secret). Never the output or an environment value.
export type DatabaseCommandRecord = {
    readonly command: CommandName;
    readonly service: ServiceName;
    readonly exitCode: number | null;
    readonly outputSha256: string | null;
    readonly attempts: number;
};
