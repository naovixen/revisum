// What the plan language says of each step type, in one table: the section it belongs to, its
// fields, whether it checks something, where in a plan it may stand, whether it sets up what the
// test needs and whether it holds steps of its own. Every list of step types
// the parser, the JSON Schema, the readable forms and the run read is derived from it, so adding a
// step type is one entry here, which the compiler demands.
import type { Step, StepByType, StepType } from "@revisum/contracts";
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

// The names of a step type's fields, those of each of its variants included: a stub's start has
// arguments that its stop does not.
type FieldsOfEach<TypedStep> = TypedStep extends unknown ? keyof TypedStep & string : never;
export type FieldOf<Type extends StepType> = FieldsOfEach<StepByType[Type]>;

// A step's fields. `type` is always required; no other field is allowed.
export type StepFields<Field extends string = string> = {
    readonly required: readonly Field[];
    readonly optional: readonly Field[];
};

// A step type's fact. The table types `Field` as the names its steps have.
export type StepFact<Field extends string = string> = {
    readonly section: StepSection;
    readonly fields: StepFields<Field>;
    // A step that checks something. A plan needs at least one, or it would pass without proving anything.
    readonly isAssertion: boolean;
    readonly placement: StepPlacement;
    // A step that sets up or reaches what the test needs: when one fails, the run could not test.
    readonly isSetup: boolean;
    // A frame or a second tab: its `steps` field holds steps of its own.
    readonly holdsSteps: boolean;
};

// One fact per step type, each naming only fields its steps have.
type StepFactTable = { readonly [Type in StepType]: StepFact<FieldOf<Type>> };

// A fact as the builders below make it, with its section and whether it holds steps kept exact, so
// the step types of a section, and those that hold steps, are typed from the table itself.
type BuiltFact<
    Section extends StepSection,
    Field extends string,
    HoldsSteps extends boolean,
> = Omit<StepFact, "section" | "fields" | "holdsSteps"> & {
    readonly section: Section;
    readonly fields: StepFields<Field>;
    readonly holdsSteps: HoldsSteps;
};
type AnyBuiltFact = BuiltFact<StepSection, string, boolean>;

const anywhere = <Section extends StepSection, Field extends string>(
    section: Section,
    required: readonly Field[],
    optional: readonly Field[] = [],
): BuiltFact<Section, "type" | Field, false> => ({
    section,
    fields: { required: ["type", ...required], optional },
    isAssertion: false,
    placement: StepPlacement.Anywhere,
    isSetup: false,
    holdsSteps: false,
});

// Every assertion carries the criterion it checks.
const assertion = <Section extends StepSection, Field extends string>(
    section: Section,
    required: readonly Field[],
    placement: StepPlacement = StepPlacement.Anywhere,
): BuiltFact<Section, "type" | Field | typeof CRITERION_FIELD, false> => ({
    section,
    fields: { required: ["type", ...required, CRITERION_FIELD], optional: [] },
    isAssertion: true,
    placement,
    isSetup: false,
    holdsSteps: false,
});

// Its `steps` field comes after its others.
const holdingSteps = <Section extends StepSection, Field extends string>(
    section: Section,
    required: readonly Field[],
): BuiltFact<Section, "type" | Field | "steps", true> => ({
    ...anywhere(section, [...required, "steps"]),
    holdsSteps: true,
});

const placedAt = <Fact extends AnyBuiltFact>(placement: StepPlacement, fact: Fact): Fact => ({
    ...fact,
    placement,
});

const settingUp = <Fact extends AnyBuiltFact>(fact: Fact): Fact => ({ ...fact, isSetup: true });

// In the order the published JSON Schema and the readable forms list the step types.
const FACTS = {
    navigate: anywhere(StepSection.Navigation, ["url"], ["scripts"]),
    click: anywhere(StepSection.Actions, ["locator"]),
    hover: anywhere(StepSection.Actions, ["locator"]),
    fill: anywhere(StepSection.Actions, ["locator", "value"]),
    select: anywhere(StepSection.Actions, ["locator", "option"]),
    upload: anywhere(StepSection.Actions, ["locator", "fixture"]),
    press: anywhere(StepSection.Actions, ["locator", "key"], ["modifiers"]),
    frame: holdingSteps(StepSection.FramesAndTabs, ["locator"]),
    dialog: anywhere(StepSection.Actions, ["action"], ["expectText"]),
    expect: assertion(StepSection.PageChecks, ["locator", "assert"]),
    expectPage: assertion(StepSection.PageChecks, ["assert"]),
    a11yAudit: anywhere(StepSection.Evidence, ["mode"]),
    capture: anywhere(StepSection.Evidence, ["name"]),
    remember: anywhere(StepSection.PageChecks, ["name", FROM_FIELD]),
    download: anywhere(StepSection.Downloads, ["name", "locator"]),
    expectDownload: assertion(StepSection.Downloads, ["download", "assert"]),
    newTab: placedAt(StepPlacement.TopLevel, holdingSteps(StepSection.FramesAndTabs, ["url"])),
    call: placedAt(
        StepPlacement.TopLevelOrCleanup,
        settingUp(anywhere(StepSection.ServiceCalls, ["call", "arguments"], ["remember"])),
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
    evaluate: settingUp(anywhere(StepSection.PageScripts, ["script", "arguments"], ["remember"])),
    expectScript: assertion(StepSection.PageScripts, ["script", "arguments", "field", "assert"]),
    database: placedAt(
        StepPlacement.TopLevelOrCleanup,
        settingUp(anywhere(StepSection.DatabaseCommands, ["command", "arguments"], ["remember"])),
    ),
    expectDatabase: assertion(
        StepSection.DatabaseCommands,
        ["command", "arguments", "field", "assert"],
        StepPlacement.TopLevel,
    ),
} satisfies StepFactTable;

export const STEP_FACTS: StepFactTable = FACTS;

// The step types of the sections given, read from the table.
export type StepTypeIn<Section extends StepSection> = {
    [Type in StepType]: (typeof FACTS)[Type]["section"] extends Section ? Type : never;
}[StepType];

// The step types that hold steps of their own, read from the table.
export type ContainerStepType = {
    [Type in StepType]: (typeof FACTS)[Type]["holdsSteps"] extends true ? Type : never;
}[StepType];

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

// True when a step of this type belongs to one of the sections given.
export const isStepTypeIn = <Section extends StepSection>(
    type: StepType,
    ...sections: readonly Section[]
): type is StepTypeIn<Section> => sections.some((section) => section === STEP_FACTS[type].section);

// True when the step belongs to one of the sections given.
export const isStepIn = <Section extends StepSection>(
    step: Step,
    ...sections: readonly Section[]
): step is StepByType[StepTypeIn<Section>] => isStepTypeIn(step.type, ...sections);

// True for a frame or a second tab.
export const holdsSteps = (step: Step): step is StepByType[ContainerStepType] =>
    STEP_FACTS[step.type].holdsSteps;

// True when a failed step of this type means the run could not test.
export const isSetupStepType = (type: StepType): boolean => STEP_FACTS[type].isSetup;
