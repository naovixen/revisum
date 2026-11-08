// Ending what a session started, one part after another.
import { errorText } from "../connection/ErrorText.ts";

// Runs every closer, whatever the others did, and gives all that went wrong, or null when nothing did.
export async function closeInTurn(
    closers: readonly (() => Promise<void>)[],
): Promise<string | null> {
    const failed: string[] = [];
    for (const close of closers) {
        try {
            await close();
        } catch (error) {
            failed.push(errorText(error));
        }
    }
    return failed.length === 0 ? null : failed.join("; ");
}
