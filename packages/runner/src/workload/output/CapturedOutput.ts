import type { CapturedOutput } from "@revisum/contracts";
import { Buffer } from "node:buffer";

// What a stream printed, cut at the limit. wasCutShort: the engine already dropped some of the output.
export function capturedOutput(text: string, limit: number, wasCutShort: boolean): CapturedOutput {
    const bytes = Buffer.from(text, "utf8");
    return bytes.length <= limit
        ? { bytes: new Uint8Array(bytes), truncated: wasCutShort }
        : { bytes: new Uint8Array(bytes.subarray(0, limit)), truncated: true };
}
