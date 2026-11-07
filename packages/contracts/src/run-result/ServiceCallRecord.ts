import type { CallName, HttpMethod, ServiceName } from "../service-calls.ts";

// What a run records of a step's call: never an argument, a header value or the body, only its
// status and the body's sha256. `attempts` counts a backend check's reads.
export type ServiceCallRecord = {
    readonly call: CallName;
    readonly service: ServiceName;
    readonly method: HttpMethod;
    readonly status: number | null;
    readonly responseSha256: string | null;
    readonly attempts: number;
};
