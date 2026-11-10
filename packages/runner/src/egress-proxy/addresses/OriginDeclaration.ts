import type { ProxyRules } from "../rules/ProxyRules.ts";

// What the proxy's rules say about something a client asked to reach.
export const OriginDeclaration = {
    Undeclared: "undeclared",
    Public: "public",
    Private: "private",
} as const;
export type OriginDeclaration = (typeof OriginDeclaration)[keyof typeof OriginDeclaration];

export type DeclarationLookup = (seen: string) => OriginDeclaration;

// Answers for one way of naming a target. `nameOf` turns a rule's origin into that name, so that a
// plain request can be judged by its origin and a tunnel by its host and port.
export function declarationLookup(
    rules: Pick<ProxyRules, "allowedOrigins" | "privateOrigins">,
    nameOf: (origin: string) => string,
): DeclarationLookup {
    const allowed = new Set(rules.allowedOrigins.map(nameOf));
    const privateNames = new Set(rules.privateOrigins.map(nameOf));
    return (seen) => {
        if (!allowed.has(seen)) {
            return OriginDeclaration.Undeclared;
        }
        return privateNames.has(seen) ? OriginDeclaration.Private : OriginDeclaration.Public;
    };
}
