import type { ResponseRewrite } from "@revisum/contracts";

export type RewrittenBody = {
    readonly body: Buffer;
    // The name of each rewrite that changed the body, in the order applied.
    readonly appliedNames: readonly string[];
};

// Applies each rewrite whose text the body holds. A body that holds none goes back byte for byte.
export function rewriteBody(body: Buffer, rewrites: readonly ResponseRewrite[]): RewrittenBody {
    const original = body.toString("utf8");
    let text = original;
    const appliedNames: string[] = [];
    for (const rewrite of rewrites) {
        if (rewrite.find === "" || !text.includes(rewrite.find)) {
            continue;
        }
        text = text.split(rewrite.find).join(rewrite.replace);
        appliedNames.push(rewrite.name);
    }
    return { body: text === original ? body : Buffer.from(text, "utf8"), appliedNames };
}
