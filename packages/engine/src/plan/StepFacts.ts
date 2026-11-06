// What the plan language says of each step type, in one table: the section it belongs to, its
// fields, whether it checks something, and where in a plan it may stand. Every list of step types
// the parser, the JSON Schema, the readable forms and the run read is derived from it, so adding a
// step type is one entry here, which the compiler demands.
import type { DatabaseCommandStep, PageScriptStep, StepType } from "@revisum/contracts";
import { CRITERION_FIELD, FROM_FIELD } from "./plan-grammar.ts";

// The family a step type belongs to. A run's executors are grouped the same way.
export const StepSection = {
    Navigation: "navigation",
    Actions: "actions",
    FramesAndTabs: "frames-and-tabs",
    PageChecks: "page-checks",
    Evidence: "evidence",
    Downloads: "downloads",
    ServiceCalls: "service-calls",
    // Stubs, request checks and web storage, which name what the trusted project declares.
    NetworkAndStorage: "network-and-storage",
    // Advancing the run's virtual clock and checking the clipboard, which need no declaration.
    ClockAndClipboard: "clock-and-clipboard",
    // The unsafe features' steps, which a plan may hold only once its project enables their feature.
    PageScripts: "page-scripts",
    DatabaseCommands: "database-commands",
} as const;
export type StepSection = (typeof StepSection)[keyof typeof StepSection];

// Where a step may stand.
//   anywhere: in the plan's own steps, a frame or a second tab;
//   topLevel: only in the plan's own list of steps. A second tab opens only from there, so a tab
//     never holds another and a frame never opens one; and a call or a database command is setup or
//     a check for the whole test, not an action in a page;
//   topLevelOrCleanup: as topLevel, or in the plan's cleanup, which holds only these.
export const StepPlacement = {
    Anywhere: "anywhere",
    TopLevel: "topLevel",
    TopLevelOrCleanup: "topLevelOrCleanup",
} as const;
export type StepPlacement = (typeof StepPlacement)[keyof typeof StepPlacement];

// A step's fields. `type` is always required; no other field is allowed.
export type StepFields = {
    readonly required: readonly string[];
    readonly optional: readonly string[];
};

export type StepFact = {
    readonly section: StepSection;
    readonly fields: StepFields;
    // A step that checks something. A plan needs at least one, or it would pass without proving anything.
    readonly isAssertion: boolean;
    readonly placement: StepPlacement;
};

const anywhere = (
    section: StepSection,
    required: readonly string[],
    optional: readonly string[] = [],
): StepFact => ({
    section,
    fields: { required: ["type", ...required], optional },
    isAssertion: false,
    placement: StepPlacement.Anywhere,
});

// Every assertion carries the criterion it checks.
const assertion = (
    section: StepSection,
    required: readonly string[],
    placement: StepPlacement = StepPlacement.Anywhere,
): StepFact => ({
    section,
    fields: { required: ["type", ...required, CRITERION_FIELD], optional: [] },
    isAssertion: true,
    placement,
});

const placedAt = (placement: StepPlacement, fact: StepFact): StepFact => ({ ...fact, placement });

// In the order the published JSON Schema and the readable forms list the step types.
export const STEP_FACTS: { readonly [Type in StepType]: StepFact } = {
    navigate: anywhere(StepSection.Navigation, ["url"], ["scripts"]),
    click: anywhere(StepSection.Actions, ["locator"]),
    hover: anywhere(StepSection.Actions, ["locator"]),
    fill: anywhere(StepSection.Actions, ["locator", "value"]),
    select: anywhere(StepSection.Actions, ["locator", "option"]),
    upload: anywhere(StepSection.Actions, ["locator", "fixture"]),
    press: anywhere(StepSection.Actions, ["locator", "key"], ["modifiers"]),
    frame: anywhere(StepSection.FramesAndTabs, ["locator", "steps"]),
    dialog: anywhere(StepSection.Actions, ["action"], ["expectText"]),
    expect: assertion(StepSection.PageChecks, ["locator", "assert"]),
    expectPage: assertion(StepSection.PageChecks, ["assert"]),
    a11yAudit: anywhere(StepSection.Evidence, ["mode"]),
    capture: anywhere(StepSection.Evidence, ["name"]),
    remember: anywhere(StepSection.PageChecks, ["name", FROM_FIELD]),
    download: anywhere(StepSection.Downloads, ["name", "locator"]),
    expectDownload: assertion(StepSection.Downloads, ["download", "assert"]),
    newTab: placedAt(StepPlacement.TopLevel, anywhere(StepSection.FramesAndTabs, ["url", "steps"])),
    call: placedAt(
        StepPlacement.TopLevelOrCleanup,
        anywhere(StepSection.ServiceCalls, ["call", "arguments"], ["remember"]),
    ),
    expectBackend: assertion(
        StepSection.ServiceCalls,
        ["call", "arguments", "field", "assert"],
        StepPlacement.TopLevel,
    ),
    // Arguments only with a start; the parser refuses them on a stop.
    stub: anywhere(StepSection.NetworkAndStorage, ["stub", "action"], ["arguments"]),
    resetRequests: anywhere(StepSection.NetworkAndStorage, ["request"]),
    expectRequests: assertion(StepSection.NetworkAndStorage, ["request", "count"]),
    expectResponse: assertion(StepSection.NetworkAndStorage, ["request", "assert"]),
    setStorage: anywhere(StepSection.NetworkAndStorage, ["entry"], ["arguments"]),
    removeStorage: anywhere(StepSection.NetworkAndStorage, ["entry"]),
    expectStorage: assertion(StepSection.NetworkAndStorage, ["entry", "assert"]),
    // An advance without a mode runs timers. It checks nothing.
    advanceClock: anywhere(StepSection.ClockAndClipboard, ["by"], ["mode"]),
    expectClipboard: assertion(StepSection.ClockAndClipboard, ["assert"]),
    evaluate: anywhere(StepSection.PageScripts, ["script", "arguments"], ["remember"]),
    expectScript: assertion(StepSection.PageScripts, ["script", "arguments", "field", "assert"]),
    database: placedAt(
        StepPlacement.TopLevelOrCleanup,
        anywhere(StepSection.DatabaseCommands, ["command", "arguments"], ["remember"]),
    ),
    expectDatabase: assertion(
        StepSection.DatabaseCommands,
        ["command", "arguments", "field", "assert"],
        StepPlacement.TopLevel,
    ),
};

const stepTypesWhere = (isWanted: (fact: StepFact) => boolean): readonly StepType[] =>
    Object.entries(STEP_FACTS).flatMap(([type, fact]) =>
        isWanted(fact) && isStepType(type) ? [type] : [],
    );

// True for a step type the plan language has.
export const isStepType = (type: string): type is StepType => Object.hasOwn(STEP_FACTS, type);

export const STEP_TYPES: readonly StepType[] = stepTypesWhere(() => true);
export const ASSERTION_STEP_TYPES: readonly StepType[] = stepTypesWhere((fact) => fact.isAssertion);

const UNSAFE_SECTIONS: readonly StepSection[] = [
    StepSection.PageScripts,
    StepSection.DatabaseCommands,
];
export const UNSAFE_STEP_TYPES: readonly StepType[] = stepTypesWhere((fact) =>
    UNSAFE_SECTIONS.includes(fact.section),
);

export const isAssertionStepType = (type: StepType): boolean => STEP_FACTS[type].isAssertion;

// True when a step of this type may stand inside a frame or a second tab.
export const canStandInside = (type: StepType): boolean =>
    STEP_FACTS[type].placement === StepPlacement.Anywhere;

// True when a plan's cleanup may hold a step of this type.
export const canStandInCleanup = (type: StepType): boolean =>
    STEP_FACTS[type].placement === StepPlacement.TopLevelOrCleanup;

export const isPageScriptStepType = (type: StepType): type is PageScriptStep["type"] =>
    STEP_FACTS[type].section === StepSection.PageScripts;

export const isDatabaseCommandStepType = (type: StepType): type is DatabaseCommandStep["type"] =>
    STEP_FACTS[type].section === StepSection.DatabaseCommands;
