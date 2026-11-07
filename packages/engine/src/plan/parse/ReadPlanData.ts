// A plan's envelope: its version, meta, targets, values, clock, steps, cleanup and saved storage
// state, read under one trusted project's rules.
import {
    failure,
    isNonArrayObject,
    PlanErrorCode,
    success,
    type FeatureId,
    type PlanData,
    type PlanError,
    type PlanMeta,
    type Result,
    type SecretReference,
    StepType,
    type Step,
    type TargetId,
} from "@revisum/contracts";
import { brand } from "../../brand.ts";
import { readId } from "../../project/project-parser.ts";
import { looksLikeCredential } from "../literal-secrets.ts";
import { allValid, INVALID, readList, type Issues, type Parsed } from "../plan-decoders.ts";
import {
    CURRENT_PLAN_VERSION,
    FEATURE_ID,
    MAXIMUM_SPEC_REFERENCE_LENGTH,
    MAXIMUM_TITLE_LENGTH,
    META_FIELDS,
    type OPTIONAL_PLAN_FIELDS,
    PLAN_FIELDS,
} from "../plan-grammar.ts";
import { readGeneratedValues, readPlanClock, type ValueContext } from "../plan-values.ts";
import { readableCopy } from "../../decoding/ReadableCopy.ts";
import { optionalField, readFields } from "../ReadFields.ts";
import { isAssertionStepType } from "../StepFacts.ts";
import { stepsWithin } from "../VisitSteps.ts";
import { readSecretReference } from "./declarations/ReadDeclared.ts";
import type { ListedFields } from "./ListedFields.ts";
import { newParseContext, type ParseContext, type PlanRules } from "./ParseContext.ts";
import { refuse } from "./Refuse.ts";
import { readCleanup, readStepList, type StepList } from "./steps/ReadStep.ts";
import { tooDeepFrame } from "./TooDeepFrame.ts";
import { readWrittenText } from "./text/ReadWrittenText.ts";

// Any other version is refused outright, with every other problem still reported: running a plan
// with the parts this parser does not know skipped would turn a skipped check into a silent pass.
const readVersion = (input: unknown, path: string, issues: Issues): Parsed<string> =>
    input === CURRENT_PLAN_VERSION
        ? CURRENT_PLAN_VERSION
        : refuse(issues, PlanErrorCode.VersionUnsupported, path);

// A feature id that is not text, or breaks the pattern, is unknown_value.
function readFeatureId(input: unknown, path: string, issues: Issues): Parsed<FeatureId> {
    if (typeof input === "string" && looksLikeCredential(input)) {
        return refuse(issues, PlanErrorCode.LiteralSecret, path);
    }
    if (typeof input !== "string" || !FEATURE_ID.test(input)) {
        return refuse(issues, PlanErrorCode.UnknownValue, path);
    }
    return brand<string, "FeatureId">(input);
}

function readMeta(input: unknown, path: string, context: ParseContext): Parsed<PlanMeta> {
    const meta = readFields(
        input,
        path,
        context.issues,
        {
            featureId: readFeatureId,
            specReference: (text: unknown, textPath: string) =>
                readWrittenText(text, textPath, context, MAXIMUM_SPEC_REFERENCE_LENGTH),
            title: (text: unknown, textPath: string) =>
                readWrittenText(text, textPath, context, MAXIMUM_TITLE_LENGTH),
        } satisfies ListedFields<(typeof META_FIELDS)[number]>,
        META_FIELDS,
    );
    return meta === INVALID
        ? INVALID
        : { featureId: meta.featureId, specReference: meta.specReference, title: meta.title };
}

function readTargetIds(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<readonly TargetId[]> {
    const { targetIds } = context.rules;
    const written = readList(input, path, context.issues, Math.max(1, targetIds.length));
    if (written === INVALID) {
        return INVALID;
    }
    const ids = written.map((value, index) => {
        const targetPath = `${path}[${index}]`;
        const targetId = readId<"TargetId">(value, targetPath, context.issues);
        if (targetId === INVALID) {
            return INVALID;
        }
        if (!targetIds.some((known) => known === targetId)) {
            return refuse(context.issues, PlanErrorCode.TargetNotInMatrix, targetPath);
        }
        return targetId;
    });
    // Two refused targets count as a duplicate too, as they always have.
    if (new Set(ids).size !== ids.length) {
        return refuse(context.issues, PlanErrorCode.Duplicate, path);
    }
    return allValid(ids) ? ids : INVALID;
}

// Checks across the whole plan once every step has been read: capture names are unique, and the
// plan checks at least one thing.
function checkWholePlan(steps: readonly Step[], path: string, issues: Issues): void {
    const all = stepsWithin(steps);
    const captureNames = all.flatMap((step) => (step.type === StepType.Capture ? [step.name] : []));
    if (new Set(captureNames).size !== captureNames.length) {
        issues.push({ code: PlanErrorCode.Duplicate, path });
    }
    if (!all.some((step) => isAssertionStepType(step.type))) {
        issues.push({ code: PlanErrorCode.Vacuous, path });
    }
}

function readPlanSteps(input: unknown, path: string, context: ParseContext): Parsed<StepList> {
    const steps = readStepList(input, path, context);
    if (steps !== INVALID) {
        checkWholePlan(steps, path, context.issues);
    }
    return steps;
}

// Saved browser storage state, named as { secretName }. Storage state written into the plan
// itself, as JSON text or as an object of cookies, is a literal secret: it is refused as a whole,
// so no part of it is read or echoed.
function readStorageState(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<SecretReference> {
    const isWrittenOut =
        typeof input === "string" ||
        (isNonArrayObject(input) && !Object.keys(input).includes("secretName"));
    if (isWrittenOut) {
        return refuse(context.issues, PlanErrorCode.LiteralSecret, path);
    }
    return readSecretReference(input, path, context);
}

// Every field of the plan, each read in turn. The plan's values come before every step, so every
// step may use them, and the cleanup after, so it may use what the steps remember.
function readEnvelope(input: unknown, context: ParseContext) {
    const valueContext: ValueContext = {
        issues: context.issues,
        emailDomains: context.rules.emailDomains,
        readText: (text, path, maximumLength) =>
            readWrittenText(text, path, context, maximumLength),
    };
    return readFields(
        input,
        "$",
        context.issues,
        {
            version: readVersion,
            meta: (meta: unknown, path: string) => readMeta(meta, path, context),
            targets: (targets: unknown, path: string) => readTargetIds(targets, path, context),
            values: optionalField((values: unknown, path: string) =>
                readGeneratedValues(values, path, valueContext, context.defined),
            ),
            clock: optionalField(readPlanClock),
            steps: (steps: unknown, path: string) => readPlanSteps(steps, path, context),
            cleanup: optionalField((cleanup: unknown) => readCleanup(cleanup, context)),
            storageState: optionalField((storageState: unknown, path: string) =>
                readStorageState(storageState, path, context),
            ),
        } satisfies ListedFields<
            (typeof PLAN_FIELDS)[number],
            (typeof OPTIONAL_PLAN_FIELDS)[number]
        >,
        PLAN_FIELDS,
    );
}

// Whatever its type says, JSON.stringify gives undefined for undefined or a symbol.
const jsonTextOf = (readable: unknown): string | undefined => JSON.stringify(readable);

// The size of a readable copy written as JSON. Writing it out can fail only for a cycle or nesting
// too deep to write, and either is too large.
const sizeInBytes = (readable: unknown): number => {
    try {
        return new TextEncoder().encode(jsonTextOf(readable) ?? "").length;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
};

// Reads a plan under `rules`, from a readable copy of `input`. Size and frame depth are checked
// first, on that copy, so an oversized plan gets one error, too_large, and nothing inside it is
// read further.
export function readPlanData(
    input: unknown,
    rules: PlanRules,
): Result<PlanData, readonly PlanError[]> {
    const readable = readableCopy(input);
    if (sizeInBytes(readable) > rules.limits.maximumPlanBytes) {
        return failure([{ code: PlanErrorCode.TooLarge, path: "$" }]);
    }
    const tooDeep = tooDeepFrame(readable, rules.limits.maximumFrameDepth);
    if (tooDeep !== undefined) {
        return failure([{ code: PlanErrorCode.TooLarge, path: tooDeep }]);
    }
    const context = newParseContext(rules);
    const plan = readEnvelope(readable, context);
    if (plan === INVALID) {
        return failure(context.issues);
    }
    const { meta, targets, steps, storageState, values, clock, cleanup } = plan;
    // Optional fields are left out when absent, so a plan without them hashes as it always did.
    return success({
        version: CURRENT_PLAN_VERSION,
        meta,
        targets,
        steps,
        ...(storageState === undefined ? {} : { storageState }),
        ...(values === undefined ? {} : { values }),
        ...(clock === undefined ? {} : { clock }),
        ...(cleanup === undefined ? {} : { cleanup }),
    });
}
