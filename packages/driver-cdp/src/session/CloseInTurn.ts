// Ending what a session started, one part after another.
import type { Result } from "@revisum/contracts";
import { errorText } from "../connection/ErrorText.ts";

// A part that ends by itself, or one that answers how its ending went, such as an egress.
export type Closer = () => Promise<void> | Promise<Result<void, string>>;

// What went wrong ending one part, or null when nothing did.
export async function closeFailureOf(close: Closer): Promise<string | null> {
    try {
        const outcome = await close();
        return outcome === undefined || outcome.ok ? null : outcome.error;
    } catch (error) {
        return errorText(error);
    }
}

// Runs every closer, whatever the others did, and gives all that went wrong, or null when nothing did.
export async function closeInTurn(closers: readonly Closer[]): Promise<string | null> {
    const failed: string[] = [];
    for (const close of closers) {
        const closeFailure = await closeFailureOf(close);
        if (closeFailure !== null) {
            failed.push(closeFailure);
        }
    }
    return failed.length === 0 ? null : failed.join("; ");
}
