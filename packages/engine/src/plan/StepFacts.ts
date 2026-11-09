// What the plan language says of each step type, in one table: the section it belongs to, its
// fields, whether it checks something, where in a plan it may stand, whether it sets up what the
// test needs, whether it holds steps of its own, whether it may change the page and what of it is
// unsafe. Every list of step types
// the parser, the JSON Schema, the readable forms and the run read is derived from it, so adding a
// step type is one entry here, which the compiler demands.
import type { CleanupStep, Step, StepByType, StepType } from "@revisum/contracts";
import { CRITERION_FIELD, FROM_FIELD } from "./schema/PlanFields.ts";
import {
    databaseStepConstructs,
    expectStepConstructs,
    locatorStepConstructs,
    noUnsafeConstructs,
    pageScriptStepConstructs,
    rememberStepConstructs,
    type UnsafeConstruct,
} from "./UnsafeConstruct.ts";

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

// A step type's fact. The table types `Field` as the names its steps have and `OwnStep` as the step
// it reads. A fact read without one can't be handed a step: nothing but the table's own lookup can.
export type StepFact<Field extends string = string, OwnStep = never> = {
    readonly section: StepSection;
    readonly fields: StepFields<Field>;
    // A step that checks something. A plan needs at least one, or it would pass without proving anything.
    readonly isAssertion: boolean;
    readonly placement: StepPlacement;
    // A step that sets up or reaches what the test needs: when one fails, the run could not test.
    readonly isSetup: boolean;
    // A frame or a second tab: its `steps` field holds steps of its own.
    readonly holdsSteps: boolean;
    // How many frames deeper than the step itself its own steps stand, counted against the
    // project's frame depth limit: 1 for a frame, 0 for any other step.
    readonly frameDepthAdded: number;
    // A navigate step or a second tab: its `url` field names a page the browser opens.
    readonly opensUrl: boolean;
    // A step after which the page may no longer be the one it stood on.
    readonly changesPage: boolean;
    // Each use of an unsafe feature a step of this type makes, at the JSON path of the field that names it.
    readonly unsafeConstructs: (step: OwnStep, path: string) => readonly UnsafeConstruct[];
};

// One fact per step type, each naming only fields its steps have.
type StepFactTable = { readonly [Type in StepType]: StepFact<FieldOf<Type>, StepByType[Type]> };

// A fact as the builders below make it, with its section, whether it holds steps and whether it
// opens a URL kept exact, so the step types of a section, those that hold steps and those that open
// a URL are typed from the table itself. Whether it changes the page and what of it is unsafe are
// left to each entry of the table, so a new step type can't inherit an answer from its builder.
type BuiltFact<
    Section extends StepSection,
    Field extends string,
    HoldsSteps extends boolean,
    OpensUrl extends boolean = false,
> = Omit<
    StepFact,
    "section" | "fields" | "holdsSteps" | "opensUrl" | "changesPage" | "unsafeConstructs"
> & {
    readonly section: Section;
    readonly fields: StepFields<Field>;
    readonly holdsSteps: HoldsSteps;
    readonly opensUrl: OpensUrl;
};
type AnyBuiltFact = BuiltFact<StepSection, string, boolean, boolean>;

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
    frameDepthAdded: 0,
    opensUrl: false,
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
    frameDepthAdded: 0,
    opensUrl: false,
});

// Its `steps` field comes after its others, and they stand `frameDepthAdded` frames deeper than it.
const holdingSteps = <Section extends StepSection, Field extends string>(
    section: Section,
    required: readonly Field[],
    frameDepthAdded: number,
): BuiltFact<Section, "type" | Field | "steps", true> => ({
    ...anywhere(section, [...required, "steps"]),
    holdsSteps: true,
    frameDepthAdded,
});

const openingUrl = <Fact extends AnyBuiltFact>(
    fact: Fact,
): Omit<Fact, "opensUrl"> & { readonly opensUrl: true } => ({ ...fact, opensUrl: true });

// Its placement kept exact, so the step types a cleanup may hold are typed from the table itself.
const placedAt = <Placement extends StepPlacement, Fact extends AnyBuiltFact>(
    placement: Placement,
    fact: Fact,
): Omit<Fact, "placement"> & { readonly placement: Placement } => ({
    ...fact,
    placement,
});

const settingUp = <Fact extends AnyBuiltFact>(fact: Fact): Fact => ({ ...fact, isSetup: true });

// A step that keeps the page it stands on and uses no unsafe feature.
const CLOSED_AND_KEEPS_PAGE = { changesPage: false, unsafeConstructs: noUnsafeConstructs };

// In the order the published JSON Schema and the readable forms list the step types.
const FACTS = {
    navigate: {
        ...openingUrl(anywhere(StepSection.Navigation, ["url"], ["scripts"])),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    click: {
        ...anywhere(StepSection.Actions, ["locator"]),
        changesPage: true,
        unsafeConstructs: locatorStepConstructs,
    },
    hover: {
        ...anywhere(StepSection.Actions, ["locator"]),
        changesPage: false,
        unsafeConstructs: locatorStepConstructs,
    },
    fill: {
        ...anywhere(StepSection.Actions, ["locator", "value"]),
        changesPage: false,
        unsafeConstructs: locatorStepConstructs,
    },
    select: {
        ...anywhere(StepSection.Actions, ["locator", "option"]),
        changesPage: true,
        unsafeConstructs: locatorStepConstructs,
    },
    upload: {
        ...anywhere(StepSection.Actions, ["locator", "fixture"]),
        changesPage: true,
        unsafeConstructs: locatorStepConstructs,
    },
    press: {
        ...anywhere(StepSection.Actions, ["locator", "key"], ["modifiers"]),
        changesPage: true,
        unsafeConstructs: locatorStepConstructs,
    },
    frame: {
        ...holdingSteps(StepSection.FramesAndTabs, ["locator"], 1),
        changesPage: false,
        unsafeConstructs: locatorStepConstructs,
    },
    dialog: {
        ...anywhere(StepSection.Actions, ["action"], ["expectText"]),
        changesPage: true,
        unsafeConstructs: noUnsafeConstructs,
    },
    expect: {
        ...assertion(StepSection.PageChecks, ["locator", "assert"]),
        changesPage: false,
        unsafeConstructs: expectStepConstructs,
    },
    expectPage: { ...assertion(StepSection.PageChecks, ["assert"]), ...CLOSED_AND_KEEPS_PAGE },
    a11yAudit: { ...anywhere(StepSection.Evidence, ["mode"]), ...CLOSED_AND_KEEPS_PAGE },
    capture: { ...anywhere(StepSection.Evidence, ["name"]), ...CLOSED_AND_KEEPS_PAGE },
    remember: {
        ...anywhere(StepSection.PageChecks, ["name", FROM_FIELD]),
        changesPage: false,
        unsafeConstructs: rememberStepConstructs,
    },
    download: {
        ...anywhere(StepSection.Downloads, ["name", "locator"]),
        changesPage: true,
        unsafeConstructs: locatorStepConstructs,
    },
    expectDownload: {
        ...assertion(StepSection.Downloads, ["download", "assert"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    // A second tab's steps count frames from the depth of the list it stands in.
    newTab: {
        ...placedAt(
            StepPlacement.TopLevel,
            openingUrl(holdingSteps(StepSection.FramesAndTabs, ["url"], 0)),
        ),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    call: {
        ...placedAt(
            StepPlacement.TopLevelOrCleanup,
            settingUp(anywhere(StepSection.ServiceCalls, ["call", "arguments"], ["remember"])),
        ),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    expectBackend: {
        ...assertion(
            StepSection.ServiceCalls,
            ["call", "arguments", "field", "assert"],
            StepPlacement.TopLevel,
        ),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    // Arguments only with a start; the parser refuses them on a stop.
    stub: {
        ...anywhere(StepSection.NetworkAndStorage, ["stub", "action"], ["arguments"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    resetRequests: {
        ...anywhere(StepSection.NetworkAndStorage, ["request"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    expectRequests: {
        ...assertion(StepSection.NetworkAndStorage, ["request", "count"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    expectResponse: {
        ...assertion(StepSection.NetworkAndStorage, ["request", "assert"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    setStorage: {
        ...anywhere(StepSection.NetworkAndStorage, ["entry"], ["arguments"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    removeStorage: {
        ...anywhere(StepSection.NetworkAndStorage, ["entry"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    expectStorage: {
        ...assertion(StepSection.NetworkAndStorage, ["entry", "assert"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    // An advance without a mode runs timers. It checks nothing.
    advanceClock: {
        ...anywhere(StepSection.ClockAndClipboard, ["by"], ["mode"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    expectClipboard: {
        ...assertion(StepSection.ClockAndClipboard, ["assert"]),
        ...CLOSED_AND_KEEPS_PAGE,
    },
    evaluate: {
        ...settingUp(anywhere(StepSection.PageScripts, ["script", "arguments"], ["remember"])),
        changesPage: true,
        unsafeConstructs: pageScriptStepConstructs,
    },
    expectScript: {
        ...assertion(StepSection.PageScripts, ["script", "arguments", "field", "assert"]),
        changesPage: false,
        unsafeConstructs: pageScriptStepConstructs,
    },
    database: {
        ...placedAt(
            StepPlacement.TopLevelOrCleanup,
            settingUp(
                anywhere(StepSection.DatabaseCommands, ["command", "arguments"], ["remember"]),
            ),
        ),
        changesPage: false,
        unsafeConstructs: databaseStepConstructs,
    },
    expectDatabase: {
        ...assertion(
            StepSection.DatabaseCommands,
            ["command", "arguments", "field", "assert"],
            StepPlacement.TopLevel,
        ),
        changesPage: false,
        unsafeConstructs: databaseStepConstructs,
    },
} satisfies StepFactTable;

// The fields each step type's fact lists, read from the table.
type ListedFieldOf<Type extends StepType> = (typeof FACTS)[Type]["fields"][
    "required" | "optional"][number];

// True when every step type's fact lists exactly the fields its steps have.
type FactsListEveryField = IsSameUnion<
    { [Type in StepType]: IsSameUnion<ListedFieldOf<Type>, FieldOf<Type>> }[StepType],
    true
>;

// Compiles only while each fact lists every field of its type, so the one check of a step's keys,
// against its fact, can't refuse a field its type has, and a reader is never handed one it lacks.
export const STEP_FACTS: Holds<FactsListEveryField> extends true ? StepFactTable : never = FACTS;

// The step types of the sections given, read from the table.
export type StepTypeIn<Section extends StepSection> = {
    [Type in StepType]: (typeof FACTS)[Type]["section"] extends Section ? Type : never;
}[StepType];

// The step types that hold steps of their own, read from the table.
export type ContainerStepType = {
    [Type in StepType]: (typeof FACTS)[Type]["holdsSteps"] extends true ? Type : never;
}[StepType];

// The step types that open a URL, read from the table.
export type UrlOpeningStepType = {
    [Type in StepType]: (typeof FACTS)[Type]["opensUrl"] extends true ? Type : never;
}[StepType];

// The step types a plan's cleanup may hold, read from the table.
type CleanupStepTypeInTable = {
    [
        Type in StepType
    ]: (typeof FACTS)[Type]["placement"] extends typeof StepPlacement.TopLevelOrCleanup
        ? Type
        : never;
}[StepType];

// True when two unions hold exactly the same members.
type IsSameUnion<Left, Right> = [Left] extends [Right]
    ? [Right] extends [Left]
        ? true
        : false
    : false;

// Compiles only when its condition is true.
type Holds<Condition extends true> = Condition;

// The contracts' CleanupStep can't read this table, so this compiles only while the two name the
// same step types.
export type CleanupStepType =
    Holds<IsSameUnion<CleanupStepTypeInTable, CleanupStep["type"]>> extends true
        ? CleanupStepTypeInTable
        : never;

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
export const canStandInCleanup = (type: StepType): type is CleanupStepType =>
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

// True for a navigate step or a second tab.
export const opensUrl = (step: Step): step is StepByType[UrlOpeningStepType] =>
    STEP_FACTS[step.type].opensUrl;

// The one frame depth rule, which the parser and the policy gate share. A list of steps stands at a
// depth: the plan's own at 0, and the steps a frame or a second tab holds at the depth of the list
// it stands in, plus its `frameDepthAdded`. A list deeper than the project's limit is too deep.
export const frameDepthInside = (type: StepType, depth: number): number =>
    depth + STEP_FACTS[type].frameDepthAdded;

// True when a list of steps `depth` frames deep is deeper than `maximumFrameDepth` allows.
export const isDeeperThanAllowed = (depth: number, maximumFrameDepth: number): boolean =>
    depth > maximumFrameDepth;

// True when a step of this type holds steps of its own.
export const holdsStepsOfType = (type: StepType): boolean => STEP_FACTS[type].holdsSteps;

// True when a failed step of this type means the run could not test.
export const isSetupStepType = (type: StepType): boolean => STEP_FACTS[type].isSetup;
