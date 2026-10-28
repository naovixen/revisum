// The audit event sink: one JSON Lines entry per event, appended, never rewritten. The audit log
// (SPEC-14) later wraps it with a hash chain and an anchor; until then this sink alone guarantees
// that what it wrote stays as written.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import { createHash, type Hash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { failure, success, type DerivedActor, type EventInput, type EventSink, type Result, type SinkError } from '@revisum/contracts';
import { sha256 } from './hashing.ts';

const NEWLINE = 0x0a;
const NOT_APPEND_ONLY: SinkError = { code: 'not-append-only' };
const WRITE_FAILED: SinkError = { code: 'write-failed' };

function readCurrent(path: string): Result<Buffer, SinkError> {
  try {
    return success(readFileSync(path));
  } catch (problem) {
    // No file yet is the empty log; any other read failure means nothing can be checked or written.
    const missing = problem instanceof Error && 'code' in problem && problem.code === 'ENOENT';
    return missing ? success(Buffer.alloc(0)) : failure(WRITE_FAILED);
  }
}

// Only the fields the event type declares, plus the derived actor, so nothing a caller slips in
// at run time reaches the log.
const entryFor = (event: EventInput, actor: DerivedActor): string => JSON.stringify({
  kind: event.kind,
  subjectHash: event.subjectHash,
  runId: event.runId,
  criterionIds: event.criterionIds,
  actor: actor.actor,
  actorType: actor.actorType,
});

// Appends to the file at `path`. Before each append the sink checks that the file still holds
// exactly the bytes it has seen and written (length and SHA-256), so a truncation or a rewrite made
// by anything else, even one that keeps the length, refuses the next append as not-append-only.
// A file that already exists is adopted as it stands at the first append, so a restarted process
// carries on the same log, and sequence numbers continue from its line count.
export function jsonLinesEventSink(path: string): EventSink {
  // A running hash of every byte the file should hold, and how many there are.
  let expected: { readonly hash: Hash; bytes: number } | undefined;
  let sequence = 0;

  return {
    append(event, actor) {
      const current = readCurrent(path);
      if (!current.ok) return current;
      const content = current.value;
      if (expected === undefined) {
        // A last line with no newline is a torn write: appending would merge two entries.
        if (content.length > 0 && content[content.length - 1] !== NEWLINE) return failure(NOT_APPEND_ONLY);
        expected = { hash: createHash('sha256').update(content), bytes: content.length };
        sequence = content.filter((byte) => byte === NEWLINE).length;
      } else if (content.length !== expected.bytes || sha256(content) !== expected.hash.copy().digest('hex')) {
        return failure(NOT_APPEND_ONLY);
      }

      const line = Buffer.from(`${entryFor(event, actor)}\n`, 'utf8');
      try {
        appendFileSync(path, line);
      } catch {
        // If part of the line reached the file, the next append sees the mismatch and refuses.
        return failure(WRITE_FAILED);
      }
      expected.hash.update(line);
      expected.bytes += line.length;
      return success({ sequence: sequence++ });
    },
  };
}
