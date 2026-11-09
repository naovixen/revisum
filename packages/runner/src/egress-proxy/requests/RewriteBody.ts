import type { ResponseRewrite } from "@revisum/contracts";

export type RewrittenBody = {
    readonly body: Buffer;
    // The name of each rewrite that changed the body, in the order applied.
    readonly appliedNames: readonly string[];
};

// Every whole occurrence of `find` replaced, or null when `find` isn't there. Bytes, not text, so a
// body that isn't UTF-8 keeps every byte but the found ones.
function replacedOccurrences(body: Buffer, find: Buffer, replace: Buffer): Buffer | null {
    let found = body.indexOf(find);
    if (found === -1) {
        return null;
    }
    const pieces: Buffer[] = [];
    let keptFrom = 0;
    while (found !== -1) {
        pieces.push(body.subarray(keptFrom, found), replace);
        keptFrom = found + find.length;
        found = body.indexOf(find, keptFrom);
    }
    pieces.push(body.subarray(keptFrom));
    return Buffer.concat(pieces);
}

// Applies each rewrite whose bytes the body holds. A body that holds none goes back as it came. The
// rewrites come from the proxy's rules, whose parser refuses an empty `find`.
export function rewriteBody(body: Buffer, rewrites: readonly ResponseRewrite[]): RewrittenBody {
    let current = body;
    const appliedNames: string[] = [];
    for (const rewrite of rewrites) {
        const replaced = replacedOccurrences(
            current,
            Buffer.from(rewrite.find),
            Buffer.from(rewrite.replace),
        );
        if (replaced !== null) {
            current = replaced;
            appliedNames.push(rewrite.name);
        }
    }
    return { body: current, appliedNames };
}
