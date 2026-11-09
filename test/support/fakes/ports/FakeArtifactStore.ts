import type { ArtifactStore } from "@revisum/engine";
import { memoryArtifactStore, type MemoryArtifactStore } from "../../builders/MemoryEventSink.ts";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// An artefact store that keeps everything in memory, where a test can read it back.
export function fakeArtifactStore(
    overrides: Partial<ArtifactStore> = {},
): Recorded<MemoryArtifactStore> {
    const defaults: MemoryArtifactStore & Required<ArtifactStore> = memoryArtifactStore();
    return recordCalls({ ...defaults, ...overrides });
}
