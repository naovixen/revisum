// The page scripts a plan names, each with the source the run was given for it, as preflight proves
// them before any side effect. The manifest records each one's sha256, and the page-script steps
// run each one's source, so neither looks a source up or can find one missing.
import {
    failure,
    success,
    type PageScriptDeclaration,
    type Plan,
    type Result,
    type ScriptName,
} from "@revisum/contracts";
import { declarationsNamedBy } from "../../../plan/UnsafeFeaturesOf.ts";
import type { Project } from "../../../project/ParseProject.ts";
import { declaredScripts } from "../../../project/ReadUnsafeFeatures.ts";

// A page script the plan names, as the project declares it, with the source the run was given for it.
export type NamedScript = {
    readonly name: ScriptName;
    readonly declaration: PageScriptDeclaration;
    readonly source: Uint8Array;
};

// Every page script a plan names, by name, each with its source.
export type NamedScripts = ReadonlyMap<ScriptName, NamedScript>;

// The page scripts the plan names, frames, second tabs and cleanup included, each with its source,
// or the declared file of the first whose source the run was not given: the manifest could not
// record what would run, so the run is refused.
export function namedScriptSources(
    plan: Plan,
    project: Project,
    scriptSources: Readonly<Record<string, Uint8Array>>,
): Result<NamedScripts, string> {
    const named = declarationsNamedBy(plan);
    const scripts = new Map<ScriptName, NamedScript>();
    for (const [declaredName, declaration] of Object.entries(
        declaredScripts(project.unsafeFeatures),
    )) {
        const name = named.scripts.find((used) => used === declaredName);
        if (name === undefined) {
            continue;
        }
        const source = Object.hasOwn(scriptSources, declaration.file)
            ? scriptSources[declaration.file]
            : undefined;
        if (source === undefined) {
            return failure(declaration.file);
        }
        scripts.set(name, { name, declaration, source });
    }
    return success(scripts);
}
