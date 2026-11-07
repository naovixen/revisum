// A step and a list of steps. A step's type is read first; a step where its type may not stand, or
// of an unsafe feature the project does not enable, is refused with nothing inside it read. Its
// fields are then checked against its type's fact, and its type's reader reads them.
import {
    PlanErrorCode,
    StepType,
    type CleanupStep,
    type Step,
    type StepByType,
} from "@revisum/contracts";
import {
    allValid,
    INVALID,
    peekRecord,
    readList,
    readOneOf,
    readRecord,
    type Parsed,
} from "../../plan-decoders.ts";
import { mapNonEmpty, type NonEmptyList } from "../../../decoding/NonEmptyList.ts";
import {
    CRITERION_FIELD,
    DATABASE_COMMAND_FEATURE,
    INLINE_SCRIPT_FEATURE,
    NAMED_SCRIPT_FEATURE,
} from "../../plan-grammar.ts";
import {
    canStandInCleanup,
    canStandInside,
    isStepTypeIn,
    STEP_FACTS,
    STEP_TYPES,
    StepSection,
    type StepTypeIn,
} from "../../StepFacts.ts";
import { isInlineScript } from "../../IsInlineScript.ts";
import { isFeatureEnabledElseRefused, nestedContext, type ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readNavigation } from "../text/ReadNavigation.ts";
import { ACTION_STEP_READERS } from "./ActionStepReaders.ts";
import { CLOCK_AND_CLIPBOARD_STEP_READERS } from "./ClockAndClipboardStepReaders.ts";
import { DATABASE_COMMAND_STEP_READERS } from "./DatabaseCommandStepReaders.ts";
import { DOWNLOAD_STEP_READERS } from "./DownloadStepReaders.ts";
import { EVIDENCE_STEP_READERS } from "./EvidenceStepReaders.ts";
import { NAVIGATION_STEP_READERS } from "./NavigationStepReaders.ts";
import { NETWORK_AND_STORAGE_STEP_READERS } from "./NetworkAndStorageStepReaders.ts";
import { PAGE_CHECK_STEP_READERS } from "./PageCheckStepReaders.ts";
import { PAGE_SCRIPT_STEP_READERS } from "./PageScriptStepReaders.ts";
import { SERVICE_CALL_STEP_READERS } from "./ServiceCallStepReaders.ts";
import { readStepLocator, type StepFieldsRead, type StepReaderTable } from "./StepReader.ts";

// A list of steps holding at least one.
export type StepList = NonEmptyList<Step>;

// A frame and a second tab read their own steps here, where step lists are read. The frame depth
// was checked before the walk began, so this recursion is bounded.
const FRAME_AND_TAB_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.FramesAndTabs>> = {
    frame(step, path, context) {
        const parts = [
            readStepLocator(step, path, context),
            readStepList(step.steps, `${path}.steps`, nestedContext(context)),
        ] as const;
        return allValid(parts)
            ? { type: StepType.Frame, locator: parts[0], steps: parts[1] }
            : INVALID;
    },
    newTab(step, path, context) {
        const parts = [
            readNavigation(step.url, `${path}.url`, context),
            readStepList(step.steps, `${path}.steps`, nestedContext(context)),
        ] as const;
        return allValid(parts)
            ? { type: StepType.NewTab, url: parts[0], steps: parts[1] }
            : INVALID;
    },
};

const STEP_READERS: StepReaderTable = {
    ...NAVIGATION_STEP_READERS,
    ...ACTION_STEP_READERS,
    ...FRAME_AND_TAB_STEP_READERS,
    ...PAGE_CHECK_STEP_READERS,
    ...EVIDENCE_STEP_READERS,
    ...DOWNLOAD_STEP_READERS,
    ...SERVICE_CALL_STEP_READERS,
    ...NETWORK_AND_STORAGE_STEP_READERS,
    ...CLOCK_AND_CLIPBOARD_STEP_READERS,
    ...PAGE_SCRIPT_STEP_READERS,
    ...DATABASE_COMMAND_STEP_READERS,
};

// True when the step's unsafe feature, if it has one, is on; otherwise it records the refusal. A
// database step needs database-command, refused at its type. A named script needs page-script,
// refused at its type; an inline one needs inline-page-script, refused at its `inline`, and a
// project can enable that only together with page-script, so one check covers both.
function isUnsafeStepEnabledElseRefused(
    type: Step["type"],
    step: { readonly script?: unknown },
    path: string,
    context: ParseContext,
): boolean {
    if (isStepTypeIn(type, StepSection.DatabaseCommands)) {
        return isFeatureEnabledElseRefused(DATABASE_COMMAND_FEATURE, `${path}.type`, context);
    }
    if (!isStepTypeIn(type, StepSection.PageScripts)) {
        return true;
    }
    if (isInlineScript(step.script)) {
        return isFeatureEnabledElseRefused(INLINE_SCRIPT_FEATURE, `${path}.script.inline`, context);
    }
    return isFeatureEnabledElseRefused(NAMED_SCRIPT_FEATURE, `${path}.type`, context);
}

// The fields a step of `type` may have, every required one there. The criterion id is checked on
// its own by the reader, so that a missing one is reported as vacuous.
function readStepFields<Type extends StepType>(
    head: Readonly<Record<string, unknown>>,
    type: Type,
    path: string,
    context: ParseContext,
): Parsed<StepFieldsRead<Type>> {
    const { required, optional } = STEP_FACTS[type].fields;
    const requiredHere = required.filter((field) => field !== CRITERION_FIELD);
    return readRecord(head, path, context.issues, [...required, ...optional], requiredHere);
}

// A step read as a record, and its type, one the plan language has.
type StepHead = {
    readonly head: Readonly<Record<string, unknown>>;
    readonly type: StepType;
};

function readStepHead(input: unknown, path: string, context: ParseContext): Parsed<StepHead> {
    const head = peekRecord(input, path, context.issues);
    if (head === INVALID) {
        return INVALID;
    }
    const type = readOneOf(
        head["type"],
        `${path}.type`,
        context.issues,
        STEP_TYPES,
        PlanErrorCode.UnknownStep,
    );
    return type === INVALID ? INVALID : { head, type };
}

// A step whose head is read and which may stand where it is. Its unsafe feature is checked, then
// its fields against its type's fact, and its type's reader reads them.
function readStepOfType<Type extends StepType>(
    head: Readonly<Record<string, unknown>>,
    type: Type,
    path: string,
    context: ParseContext,
): Parsed<StepByType[Type]> {
    if (!isUnsafeStepEnabledElseRefused(type, head, path, context)) {
        return INVALID;
    }
    const step = readStepFields(head, type, path, context);
    const readerOfType: StepReaderTable[Type] = STEP_READERS[type];
    return step === INVALID ? INVALID : readerOfType(step, path, context);
}

export function readStep(input: unknown, path: string, context: ParseContext): Parsed<Step> {
    const read = readStepHead(input, path, context);
    if (read === INVALID) {
        return INVALID;
    }
    // A second tab, a call or a database command stands only in the plan's own list of steps.
    if (!canStandInside(read.type) && !context.topLevel) {
        return refuse(context.issues, PlanErrorCode.MisplacedStep, path);
    }
    return readStepOfType(read.head, read.type, path, context);
}

// A non-empty list of steps, every one read so that a rejection lists every problem.
export function readStepList(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<StepList> {
    const written = readList(input, path, context.issues, context.rules.limits.maximumSteps);
    if (written === INVALID) {
        return INVALID;
    }
    const steps = mapNonEmpty(written, (step, index) =>
        readStep(step, `${path}[${index}]`, context),
    );
    return allValid(steps) ? steps : INVALID;
}

function readCleanupStep(input: unknown, path: string, context: ParseContext): Parsed<CleanupStep> {
    const read = readStepHead(input, path, context);
    if (read === INVALID) {
        return INVALID;
    }
    // Nothing inside a misplaced step is read.
    if (!canStandInCleanup(read.type)) {
        return refuse(context.issues, PlanErrorCode.MisplacedStep, path);
    }
    return readStepOfType(read.head, read.type, path, context);
}

// The plan's cleanup: calls and database commands only, read after the steps, so they may use the
// values the steps remember.
export function readCleanup(input: unknown, context: ParseContext): Parsed<readonly CleanupStep[]> {
    const path = "$.cleanup";
    const written = readList(input, path, context.issues, context.rules.limits.maximumSteps, 0);
    if (written === INVALID) {
        return INVALID;
    }
    const steps = written.map((step, index) => readCleanupStep(step, `${path}[${index}]`, context));
    return allValid(steps) ? steps : INVALID;
}
