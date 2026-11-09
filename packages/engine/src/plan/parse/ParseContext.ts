// What the plan parser carries while it reads one plan: the trusted project's rules, the issues
// found so far and what the plan has defined so far, in document order.
import {
    PlanErrorCode,
    type CallDeclaration,
    type CallName,
    type CommandName,
    type DatabaseCommandDeclaration,
    type EmailDomain,
    type FixtureName,
    type ObservedRequestDeclaration,
    type Origin,
    type PageScriptDeclaration,
    type RequestName,
    type ScriptName,
    type SecretName,
    type StorageEntryDeclaration,
    type StorageEntryName,
    type StubDeclaration,
    type StubName,
    type TargetId,
    type TestIdAttribute,
    type UnsafeFeature,
} from "@revisum/contracts";
import type { Limits, Project } from "../../project/ParseProject.ts";
import {
    declaredCommands,
    declaredScripts,
    enabledUnsafeFeatures,
} from "../../project/ReadUnsafeFeatures.ts";
import type { Issues } from "../../decoding/ReadRecord.ts";

// What a plan may refer to, taken from the trusted project.
export type PlanRules = {
    readonly origins: readonly Origin[];
    readonly targetIds: readonly TargetId[];
    readonly secretNames: readonly SecretName[];
    readonly fixtures: readonly FixtureName[];
    readonly limits: Limits;
    readonly testIdAttributes: readonly TestIdAttribute[];
    readonly emailDomains: readonly EmailDomain[];
    // The calls a call step may name.
    readonly calls: Readonly<Record<CallName, CallDeclaration>>;
    // The stubs, observed requests and storage entries the steps may name.
    readonly stubs: Readonly<Record<StubName, StubDeclaration>>;
    readonly observedRequests: Readonly<Record<RequestName, ObservedRequestDeclaration>>;
    readonly storageEntries: Readonly<Record<StorageEntryName, StorageEntryDeclaration>>;
    // The unsafe features the trusted project enables, and the page scripts and database commands
    // a plan may name once their feature is on.
    readonly unsafeFeatures: readonly UnsafeFeature[];
    readonly pageScripts: Readonly<Record<ScriptName, PageScriptDeclaration>>;
    readonly databaseCommands: Readonly<Record<CommandName, DatabaseCommandDeclaration>>;
};

export type ParseContext = {
    readonly rules: PlanRules;
    readonly issues: Issues;
    // The run values defined so far, in document order: the plan's values, then each remember
    // step's name once that step has been read. A reference to any other name is undefined.
    readonly defined: Set<string>;
    // The download names defined so far, in document order, each by its download step. They share
    // one plan-wide namespace with the run values, so a name is defined once across both.
    readonly downloads: Set<string>;
    // True while reading the plan's own list of steps, not the steps inside a frame or a second tab.
    readonly topLevel: boolean;
    // The stubs started so far, in document order, anywhere in the plan: a stub applies to the
    // whole browser context, so a stop anywhere after its start is valid.
    readonly startedStubs: Set<string>;
    // How far the advances read so far move the clock, in document order, anywhere in the plan, and
    // whether the plan limit has been passed: only the step that first passes it is refused.
    readonly clockAdvance: { milliseconds: number; limitPassed: boolean };
};

export const planRulesOf = (project: Project): PlanRules => ({
    origins: project.origins,
    targetIds: project.matrix.map((target) => target.id),
    secretNames: project.secretNames,
    fixtures: project.fixtures,
    limits: project.limits,
    testIdAttributes: project.testIdAttributes,
    emailDomains: project.generatedEmailDomains,
    calls: project.calls,
    stubs: project.stubs,
    observedRequests: project.observedRequests,
    storageEntries: project.storageEntries,
    unsafeFeatures: enabledUnsafeFeatures(project.unsafeFeatures),
    pageScripts: declaredScripts(project.unsafeFeatures),
    databaseCommands: declaredCommands(project.unsafeFeatures),
});

// The context for a plan's own list of steps, before anything in it has been read.
export const newParseContext = (rules: PlanRules): ParseContext => ({
    rules,
    issues: [],
    defined: new Set(),
    downloads: new Set(),
    topLevel: true,
    startedStubs: new Set(),
    clockAdvance: { milliseconds: 0, limitPassed: false },
});

// The context for the steps inside a frame or a second tab: the same plan, below its top level.
export const nestedContext = (context: ParseContext): ParseContext => ({
    ...context,
    topLevel: false,
});

// True when a run value or a download already has the name: the two share one namespace.
export const isNameTaken = (name: string, context: ParseContext): boolean =>
    context.defined.has(name) || context.downloads.has(name);

// True when the trusted project enables `feature`. Otherwise it records unsafe_feature_disabled at
// `path`, the field that names it, and the caller reads nothing under it, so no part of it is
// echoed or judged.
export function isFeatureEnabledElseRefused(
    feature: UnsafeFeature,
    path: string,
    context: ParseContext,
): boolean {
    if (context.rules.unsafeFeatures.includes(feature)) {
        return true;
    }
    context.issues.push({ code: PlanErrorCode.UnsafeFeatureDisabled, path });
    return false;
}
