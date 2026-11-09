import { success, type ServiceCaller } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A service that answers every call 200 with an empty JSON object.
export function fakeServiceCaller(overrides: Partial<ServiceCaller> = {}): Recorded<ServiceCaller> {
    const defaults: Required<ServiceCaller> = {
        call: () =>
            Promise.resolve(
                success({
                    status: 200,
                    mediaType: "application/json",
                    body: new TextEncoder().encode("{}"),
                }),
            ),
    };
    return recordCalls({ ...defaults, ...overrides });
}
