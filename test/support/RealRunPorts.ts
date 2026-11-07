import type { RunPorts } from "@revisum/engine";
import { fakePorts } from "./fakes/FakePorts.ts";

// The ports of a run on a real browser. Its drivers are the point of it and are always given. Only
// what a browser run has no business with stays in memory: a service or database command it was not
// given is unwired, so an undeclared call is refused with services-unavailable, as on a real run,
// rather than answered by a fake.
export const realRunPorts = (given: Partial<RunPorts> & Pick<RunPorts, "drivers">): RunPorts =>
    fakePorts(given);
