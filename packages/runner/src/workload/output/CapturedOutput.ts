import type { CapturedOutput } from "@revisum/contracts";
import { Buffer } from "node:buffer";

// What a stream printed, cut at the limit.
export function capturedOutput(text: string, limit: number): CapturedOutput {
    const bytes = Buffer.from(text, "utf8");
    return bytes.length <= limit
        ? { bytes: new Uint8Array(bytes), truncated: false }
        : { bytes: new Uint8Array(bytes.subarray(0, limit)), truncated: true };
}
