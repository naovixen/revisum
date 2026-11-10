import type { ScriptName } from "../../plan/steps/UnsafeFeaturesDeclaration.ts";

// What a run keeps of a page-script step: the script's name (null for one written in the plan),
// how many times it ran, and the sha256 of the last result text it accepted (null when none was, or
// when it held a secret).
export type PageScriptRecord = {
    readonly script: ScriptName | null;
    readonly attempts: number;
    readonly resultSha256: string | null;
};
