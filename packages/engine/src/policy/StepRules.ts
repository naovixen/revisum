// What the policy gate checks of each step type, before the run, in its pass over what the plan calls,
// and as it acts, in one table. Every
// step type has an entry, so a new type does not compile until someone decides what may deny it:
// nothing is allowed by default for want of a case.
import { literalText } from "@revisum/contracts";
import type {
    AllowedUrl,
    DatabaseCommandStep,
    Locator,
    PageScriptStep,
    PathTemplate,
    PolicyRuleId,
    RemoveStorageStep,
    ResolvedElement,
    SafeText,
    ServiceCallStep,
    SetStorageStep,
    Step,
    StepByType,
    StepType,
    StubStep,
} from "@revisum/contracts";
import type { Project, ProjectPolicy } from "../project/project-parser.ts";
import { isInlineScript } from "../plan/IsInlineScript.ts";
import { declaredCommands, declaredScripts } from "../project/unsafe-feature-declarations.ts";
import { isDestructivePath, readUrl, type ReadUrl } from "./IsDestructivePath.ts";
import { isAllowedName, isBlankName, matchesIrreversiblePattern } from "./irreversible-patterns.ts";

// What the static check judges a step with, made once for the whole plan.
export type StaticContext = {
    readonly project: Project;
    readonly patterns: readonly string[];
    readonly productionAllowed: boolean;
    // False for a proposal: a plan with no approval.
    readonly approved: boolean;
};

// What the runtime guard judges an action with: the element the driver resolved, any open dialog's
// text, and the irreversible patterns of the target's locale.
export type GuardedAction = {
    readonly element: ResolvedElement;
    readonly dialogText: string | null;
    readonly patterns: readonly string[];
    readonly project: Project;
};

type StaticRule<TypedStep extends Step> = (
    step: TypedStep,
    context: StaticContext,
) => PolicyRuleId | null;

type StepRule<TypedStep extends Step> = {
    // The static check, before the run starts, over every step, those in frames and second tabs
    // included.
    readonly beforeRun: StaticRule<TypedStep>;
    // The static check's pass over what the plan calls, after every step's own rule: the plan's own
    // steps, then its cleanup. Calls and database commands stand only there.
    readonly beforeRunCalls: StaticRule<TypedStep>;
    // The runtime guard, just before the driver acts.
    readonly duringRun: (step: TypedStep, action: GuardedAction) => PolicyRuleId | null;
};

// Keys that press a focused control or submit the form around a focused field. Held modifiers
// do not change that: Control+Enter and Shift+Enter submit many forms, so a chord is judged by
// its key alone.
const ACTIVATING_KEYS: readonly string[] = ["Enter", "Space"];

const isBlank = (text: string | null): boolean => text === null || isBlankName(text);

// The accessible name a locator asks for, when the plan itself says it. A test id names no text,
// and a value reference has none until the run; the runtime guard then sees the element's name.
function locatorName(locator: Locator): string | null {
    switch (locator.by) {
        case "role":
            return literalText(locator.name) ?? null;
        case "label":
            return literalText(locator.label) ?? null;
        case "text":
            return literalText(locator.text) ?? null;
        case "testId":
        case "css":
        case "xpath":
            return null;
    }
}

// The selector or expression of a css or XPath locator; undefined for any other.
function structuralQuery(locator: Locator): SafeText | undefined {
    switch (locator.by) {
        case "css":
            return locator.selector;
        case "xpath":
            return locator.expression;
        case "role":
        case "label":
        case "text":
        case "testId":
            return undefined;
    }
}

// The part of a path template the plan fixes: its literal segments up to the first value. A
// destructive path there is destructive whatever the values are; the runtime guard checks the
// whole URL once the values are known.
function literalPathOf(template: PathTemplate): string {
    const literal: string[] = [];
    for (const segment of template.segments) {
        const text = literalText(segment);
        if (text === undefined) {
            break;
        }
        literal.push(text);
    }
    return `/${literal.join("/")}`;
}

// The URL a navigate step names, as far as the plan alone says it. A URL the parser accepted always
// reads. A path template's text may not: an http URL reads a backslash as a "/", so a segment that
// is one names a host with no name, and a URL with no host cannot be read. It reaches no declared
// origin.
const readNavigation = (url: AllowedUrl | PathTemplate): ReadUrl | null =>
    typeof url === "string" ? readUrl(url) : readUrl(literalPathOf(url));

// True when the name marks an irreversible action the project has not allowed by name.
const isIrreversibleName = (
    name: string,
    patterns: readonly string[],
    policy: ProjectPolicy,
): boolean =>
    matchesIrreversiblePattern(name, patterns) &&
    !isAllowedName(name, policy.allowedIrreversibleNames);

// ---- Before the run -------------------------------------------------------------------------------

const noRuleBeforeRun = (): null => null;

function navigationRule(
    url: AllowedUrl | PathTemplate,
    context: StaticContext,
): PolicyRuleId | null {
    const read = readNavigation(url);
    if (read === null) {
        return "undeclared-origin";
    }
    if (read.origin !== null) {
        if (!context.project.origins.some((origin) => origin === read.origin)) {
            return "undeclared-origin";
        }
        if (
            !context.productionAllowed &&
            context.project.productionOrigins.some((origin) => origin === read.origin)
        ) {
            return "production-origin";
        }
    }
    return isDestructivePath(read.path, context.project.policy) ? "destructive-navigation" : null;
}

// A click whose locator names an irreversible action.
function irreversibleClickRule(
    step: { readonly locator: Locator },
    context: StaticContext,
): PolicyRuleId | null {
    const name = locatorName(step.locator);
    return name !== null && isIrreversibleName(name, context.patterns, context.project.policy)
        ? "irreversible-action"
        : null;
}

// A side effect a proposal may hold only when the declaration it names allows it in proposals. A
// name the project does not declare reaches something nobody declared.
function proposalSideEffectRule(
    declaration: { readonly allowInProposals: boolean } | undefined,
    isSideEffect: boolean,
    context: StaticContext,
): PolicyRuleId | null {
    if (declaration === undefined) {
        return "undeclared-origin";
    }
    return isSideEffect && !context.approved && !declaration.allowInProposals
        ? "side-effect-in-proposal"
        : null;
}

// Starting a stub fakes a response. Stopping one undoes that side effect, so it is never one.
const stubRule = (step: StubStep, context: StaticContext): PolicyRuleId | null =>
    proposalSideEffectRule(
        Object.entries(context.project.stubs).find(([name]) => name === step.stub)?.[1],
        step.action === "start",
        context,
    );

// Writing an entry changes the page's storage, and removing one is a write too.
const storageRule = (
    step: SetStorageStep | RemoveStorageStep,
    context: StaticContext,
): PolicyRuleId | null =>
    proposalSideEffectRule(
        Object.entries(context.project.storageEntries).find(([name]) => name === step.entry)?.[1],
        true,
        context,
    );

// What a page script may not do: run undeclared, whatever the plan's standing, since a script the
// project does not declare is no one's. And in a proposal: be written into the plan, since its source
// and its claimed effect are the plan's own and no person declared them; or change something unless
// its declaration allows it in proposals.
function scriptRule(step: PageScriptStep, context: StaticContext): PolicyRuleId | null {
    if (isInlineScript(step.script)) {
        return context.approved ? null : "inline-script-in-proposal";
    }
    const name = step.script;
    const declaration = Object.entries(declaredScripts(context.project.unsafeFeatures)).find(
        ([declared]) => declared === name,
    )?.[1];
    if (declaration === undefined) {
        return "undeclared-origin";
    }
    return !context.approved && declaration.effect === "write" && !declaration.allowInProposals
        ? "side-effect-in-proposal"
        : null;
}

// ---- What the plan calls ------------------------------------------------------------------------------

// What a call may not do: reach a production service the plan's standing does not open, or, in a
// proposal, change something unless its declaration allows it in proposals. A call the project
// does not declare, or whose service it does not declare, reaches somewhere nobody declared.
function callRule(step: ServiceCallStep, context: StaticContext): PolicyRuleId | null {
    const declaration = Object.entries(context.project.calls).find(
        ([name]) => name === step.call,
    )?.[1];
    const service = context.project.services.find(
        (candidate) => candidate.name === declaration?.service,
    );
    if (declaration === undefined || service === undefined) {
        return "undeclared-origin";
    }
    if (
        !context.productionAllowed &&
        context.project.productionOrigins.some((origin) => origin === service.origin)
    ) {
        return "production-origin";
    }
    return !context.approved && declaration.effect === "write" && !declaration.allowInProposals
        ? "side-effect-in-proposal"
        : null;
}

// What a database command may not do: reach a service on a production origin, whatever the plan's
// standing, since the gate cannot judge what the team's program does there; or, in a proposal,
// change something unless its declaration allows it in proposals.
function commandRule(step: DatabaseCommandStep, context: StaticContext): PolicyRuleId | null {
    const declaration = Object.entries(declaredCommands(context.project.unsafeFeatures)).find(
        ([name]) => name === step.command,
    )?.[1];
    const service = context.project.services.find(
        (candidate) => candidate.name === declaration?.service,
    );
    if (declaration === undefined || service === undefined) {
        return "undeclared-origin";
    }
    if (context.project.productionOrigins.some((origin) => origin === service.origin)) {
        return "production-origin";
    }
    return !context.approved && declaration.effect === "write" && !declaration.allowInProposals
        ? "side-effect-in-proposal"
        : null;
}

// ---- As the run acts ------------------------------------------------------------------------------

const noRuleDuringRun = (): null => null;

// Production depends on the plan's standing, which only the static check has. The run passes a
// path template here with its values already in place.
function navigationGuard(
    url: AllowedUrl | PathTemplate,
    action: GuardedAction,
): PolicyRuleId | null {
    const read = readNavigation(url);
    if (
        read === null ||
        (read.origin !== null && !action.project.origins.some((origin) => origin === read.origin))
    ) {
        return "undeclared-origin";
    }
    return isDestructivePath(read.path, action.project.policy) ? "destructive-navigation" : null;
}

const isIrreversibleText = (text: string | null, action: GuardedAction): boolean =>
    text !== null && isIrreversibleName(text, action.patterns, action.project.policy);

// A control with no accessible name could be anything, so it is acted on only when the project
// allows it by test id, either the one the locator used or the element's own, or, for a css or
// XPath locator, by that exact selector or expression in its unsafe features' list.
function isAllowedUnnamed(locator: Locator, element: ResolvedElement, project: Project): boolean {
    const allowed = project.policy.unnamedControlsAllowedByTestId;
    const testId = locator.by === "testId" ? literalText(locator.testId) : undefined;
    const structural = structuralQuery(locator);
    return (
        (testId !== undefined && allowed.includes(testId)) ||
        (element.testId !== undefined &&
            allowed.some((allowedId) => allowedId === element.testId)) ||
        (structural !== undefined &&
            (project.unsafeFeatures?.unnamedControlsAllowed ?? []).includes(structural))
    );
}

function linkRule(element: ResolvedElement, policy: ProjectPolicy): PolicyRuleId | null {
    if (element.linkUrl === null) {
        return null;
    }
    const read = readUrl(element.linkUrl);
    return read !== null && isDestructivePath(read.path, policy) ? "destructive-navigation" : null;
}

// Any action on an element first needs a name, or the project's leave to act on it without one.
const unnamedControlRule = (
    step: { readonly locator: Locator },
    action: GuardedAction,
): PolicyRuleId | null =>
    isBlank(action.element.name) && !isAllowedUnnamed(step.locator, action.element, action.project)
        ? "unnamed-control"
        : null;

function clickGuard(
    step: { readonly locator: Locator },
    action: GuardedAction,
): PolicyRuleId | null {
    const unnamed = unnamedControlRule(step, action);
    if (unnamed !== null) {
        return unnamed;
    }
    return isIrreversibleText(action.element.name, action)
        ? "irreversible-action"
        : linkRule(action.element, action.project.policy);
}

// Enter or Space presses a focused button or link as a click would, and submits the form around a
// focused field.
function pressGuard(step: StepByType["press"], action: GuardedAction): PolicyRuleId | null {
    const unnamed = unnamedControlRule(step, action);
    if (unnamed !== null || !ACTIVATING_KEYS.includes(step.key)) {
        return unnamed;
    }
    if (isIrreversibleText(action.element.name, action)) {
        return "irreversible-action";
    }
    return (
        linkRule(action.element, action.project.policy) ??
        (isIrreversibleText(action.element.formSubmitName, action) ? "irreversible-submit" : null)
    );
}

// ---- The table ------------------------------------------------------------------------------------

// A second tab opens its URL as a navigate step would.
const navigationRules: StepRule<StepByType["navigate" | "newTab"]> = {
    beforeRun: (step, context) => navigationRule(step.url, context),
    beforeRunCalls: noRuleBeforeRun,
    duringRun: (step, action) => navigationGuard(step.url, action),
};

// A download is a click that must start a download, so it is judged as the click it is.
const clickRules: StepRule<StepByType["click" | "download"]> = {
    beforeRun: irreversibleClickRule,
    beforeRunCalls: noRuleBeforeRun,
    duringRun: clickGuard,
};

const elementActionRules: StepRule<StepByType["hover" | "fill" | "select" | "upload"]> = {
    beforeRun: noRuleBeforeRun,
    beforeRunCalls: noRuleBeforeRun,
    duringRun: unnamedControlRule,
};

// None of the next three sends input to the page, so the runtime guard has nothing to judge.
const stubRules: StepRule<StubStep> = {
    beforeRun: stubRule,
    beforeRunCalls: noRuleBeforeRun,
    duringRun: noRuleDuringRun,
};

const storageRules: StepRule<SetStorageStep | RemoveStorageStep> = {
    beforeRun: storageRule,
    beforeRunCalls: noRuleBeforeRun,
    duringRun: noRuleDuringRun,
};

const scriptRules: StepRule<PageScriptStep> = {
    beforeRun: scriptRule,
    beforeRunCalls: noRuleBeforeRun,
    duringRun: noRuleDuringRun,
};

// A call or a database command reaches outside the browser, so it is judged by what it calls,
// cleanup included, after every step's own rule. It sends no input to the page.
const callRules: StepRule<ServiceCallStep> = {
    beforeRun: noRuleBeforeRun,
    beforeRunCalls: callRule,
    duringRun: noRuleDuringRun,
};

const commandRules: StepRule<DatabaseCommandStep> = {
    beforeRun: noRuleBeforeRun,
    beforeRunCalls: commandRule,
    duringRun: noRuleDuringRun,
};

// Checks, evidence and remembering only read, and a clock advance moves the page's own clock: none
// sends input, so none is a side effect, and a proposal may hold each.
const readOnlyRules: StepRule<Step> = {
    beforeRun: noRuleBeforeRun,
    beforeRunCalls: noRuleBeforeRun,
    duringRun: noRuleDuringRun,
};

export const STEP_RULES: { readonly [Type in StepType]: StepRule<StepByType[Type]> } = {
    navigate: navigationRules,
    newTab: navigationRules,
    click: clickRules,
    download: clickRules,
    hover: elementActionRules,
    fill: elementActionRules,
    select: elementActionRules,
    upload: elementActionRules,
    press: { beforeRun: noRuleBeforeRun, beforeRunCalls: noRuleBeforeRun, duringRun: pressGuard },
    // The driver answers the dialog the page opened, so only the runtime guard can read its text.
    dialog: {
        beforeRun: noRuleBeforeRun,
        beforeRunCalls: noRuleBeforeRun,
        duringRun: (step, action) =>
            step.action === "accept" && isIrreversibleText(action.dialogText, action)
                ? "irreversible-dialog"
                : null,
    },
    // A frame's own steps are judged one by one, as the steps of the page around it are.
    frame: readOnlyRules,
    expect: readOnlyRules,
    expectPage: readOnlyRules,
    expectDownload: readOnlyRules,
    a11yAudit: readOnlyRules,
    capture: readOnlyRules,
    remember: readOnlyRules,
    call: callRules,
    expectBackend: callRules,
    stub: stubRules,
    setStorage: storageRules,
    removeStorage: storageRules,
    resetRequests: readOnlyRules,
    expectRequests: readOnlyRules,
    expectResponse: readOnlyRules,
    expectStorage: readOnlyRules,
    advanceClock: readOnlyRules,
    expectClipboard: readOnlyRules,
    // A page script acts on no element the guard could see: the static check judged its declaration.
    evaluate: scriptRules,
    expectScript: scriptRules,
    database: commandRules,
    expectDatabase: commandRules,
};

// A column's rule for the step's own type. Callers hand only the step, so its type and the step it
// types cannot come apart.
const staticRuleFor = <Type extends StepType>(
    column: "beforeRun" | "beforeRunCalls",
    type: Type,
    step: StepByType[Type],
    context: StaticContext,
): PolicyRuleId | null => STEP_RULES[type][column](step, context);

const guardFor = <Type extends StepType>(
    type: Type,
    step: StepByType[Type],
    action: GuardedAction,
): PolicyRuleId | null => STEP_RULES[type].duringRun(step, action);

// The static check's rule for one step: what denies it, or null.
export const ruleBeforeRun = (step: Step, context: StaticContext): PolicyRuleId | null =>
    staticRuleFor("beforeRun", step.type, step, context);

// The static check's rule for what one step calls: what denies it, or null.
export const callRuleBeforeRun = (step: Step, context: StaticContext): PolicyRuleId | null =>
    staticRuleFor("beforeRunCalls", step.type, step, context);

// The runtime guard's rule for one action: what denies it, or null.
export const ruleDuringRun = (step: Step, action: GuardedAction): PolicyRuleId | null =>
    guardFor(step.type, step, action);
