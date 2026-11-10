// Why a workload was refused, and the log line that says so.
import { failure, type Failure, type WorkloadErrorCode } from "@revisum/contracts";

// A refusal's reason, or a notice: something that did not stop the run but limits what it shows.
export type WorkloadLogEntry = {
    readonly code: WorkloadErrorCode | "notice";
    readonly detail: string;
};

export type WorkloadLog = (entry: WorkloadLogEntry) => void;

export type WorkloadRefusal = { readonly code: WorkloadErrorCode; readonly detail: string };

export const workloadRefused = (
    code: WorkloadErrorCode,
    detail: string,
): Failure<WorkloadRefusal> => failure({ code, detail });
