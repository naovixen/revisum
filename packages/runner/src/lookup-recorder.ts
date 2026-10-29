// A name server that answers every lookup with "no such name" and records the name asked for. The
// proxy container runs it for a workload's network: Docker's own resolver answers for the run's
// containers and forwards every other name here. A process that ignores the proxy has no route
// out anyway; its lookup is the only trace of its attempt, so it is recorded with channel process.
// Queries arrive from code Revisum does not trust, so each is read by hand under fixed limits and
// anything malformed is dropped unanswered.
// See docs/specs/SPEC-35-evidence-mode.md.
import { Buffer } from 'node:buffer';
import { createSocket } from 'node:dgram';

const HEADER_BYTES = 12;
const MAXIMUM_QUERY_BYTES = 512;
const MAXIMUM_NAME_LENGTH = 253;
// The "response" flag and the name-error answer code ("no such name").
const RESPONSE_FLAGS = 0x8180;
const NAME_ERROR = 3;

export type DnsQuestion = { readonly name: string; readonly end: number };

// The first question of a standard query: its name, lower case and without a trailing dot, and
// where the question ends. Null for anything else: a response, another opcode, a compressed or
// oversized name.
export function readDnsQuestion(message: Uint8Array): DnsQuestion | null {
  if (message.length < HEADER_BYTES || message.length > MAXIMUM_QUERY_BYTES) return null;
  const bytes = Buffer.from(message);
  const flags = bytes.readUInt16BE(2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >> 11) & 0x0f;
  if (isResponse || opcode !== 0 || bytes.readUInt16BE(4) < 1) return null;
  const labels: string[] = [];
  let offset = HEADER_BYTES;
  for (;;) {
    const length = bytes[offset];
    if (length === undefined) return null;
    offset += 1;
    if (length === 0) break;
    // A compression pointer, or a label longer than the format allows.
    if (length > 63) return null;
    if (offset + length > bytes.length) return null;
    labels.push(bytes.subarray(offset, offset + length).toString('latin1').toLowerCase());
    offset += length;
  }
  // The question's type and class follow its name.
  const end = offset + 4;
  const name = labels.join('.');
  if (end > bytes.length || name === '' || name.length > MAXIMUM_NAME_LENGTH) return null;
  return { name, end };
}

// The answer to a query: its header and question, flagged as a response with "no such name" and
// no records.
export function noSuchNameAnswer(message: Uint8Array, question: DnsQuestion): Uint8Array {
  const answer = Buffer.from(message.subarray(0, question.end));
  const recursionWanted = answer.readUInt16BE(2) & 0x0100;
  answer.writeUInt16BE(RESPONSE_FLAGS | recursionWanted | NAME_ERROR, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt16BE(0, 6);
  answer.writeUInt16BE(0, 8);
  answer.writeUInt16BE(0, 10);
  return new Uint8Array(answer);
}

// Listens on UDP port 53 of every interface and calls onLookup with each name asked for.
export function startLookupRecorder(onLookup: (name: string) => void): Promise<void> {
  const socket = createSocket('udp4');
  socket.on('message', (message, sender) => {
    const question = readDnsQuestion(message);
    if (question === null) return;
    onLookup(question.name);
    socket.send(noSuchNameAnswer(message, question), sender.port, sender.address);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(53, '0.0.0.0', () => {
      socket.off('error', reject);
      // A failed send to one sender must not stop the recorder for the others.
      socket.on('error', () => undefined);
      resolve();
    });
  });
}
