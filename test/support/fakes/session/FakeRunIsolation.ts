import { GuaranteeLevel, type RunIsolation } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A run's isolation that says the level it is given: on the host unless a test says otherwise.
export const fakeRunIsolation = (
    level: GuaranteeLevel = GuaranteeLevel.Host,
): Recorded<RunIsolation> => recordCalls({ guaranteeLevel: () => level });
