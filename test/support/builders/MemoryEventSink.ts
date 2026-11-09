// In-memory implementations of the storage and time ports, for tests only.
import {
  sha256, success,
  type ArtifactReference, type ArtifactStore, type Clock, type DerivedActor, type EventInput, type EventSink,
  type LoggedEvent, type RunEventSink,
} from '@revisum/engine';

export function memoryRunEventSink(): RunEventSink {
  const events: LoggedEvent[] = [];
  return {
    append: (event) => { events.push(Object.freeze(event)); },
    read: () => Object.freeze([...events]),
  };
}

// An audit sink that keeps every event it is given, with the actor it was appended for, so a
// test can read back what was recorded. Every run's ports need one.
export type RecordedEvent = { readonly event: EventInput; readonly actor: DerivedActor };
export type MemoryEventSink = EventSink & { readonly recorded: readonly RecordedEvent[] };

export function memoryEventSink(): MemoryEventSink {
  const recorded: RecordedEvent[] = [];
  return {
    recorded,
    append(event, actor) {
      recorded.push({ event, actor });
      return success({ sequence: recorded.length - 1 });
    },
  };
}

export type MemoryArtifactStore = ArtifactStore & {
  get(name: string): Uint8Array | undefined;
  references(): readonly ArtifactReference[];
};

export function memoryArtifactStore(): MemoryArtifactStore {
  const data = new Map<string, Uint8Array>();
  const references: ArtifactReference[] = [];
  return {
    async put(name, bytes, mediaType) {
      if (data.has(name)) throw new Error(`artifact already exists: ${name}`);
      data.set(name, bytes);
      const reference = { name, mediaType, sha256: sha256(bytes), bytes: bytes.length };
      references.push(reference);
      return reference;
    },
    get: (name) => data.get(name),
    references: () => [...references],
  };
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
