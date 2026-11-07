// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome. Stubs, request checks and web
// storage go through the session's network and storage ports; clock advances and clipboard reads
// through its clock and clipboard ports; page scripts through its script port. Database commands
// go through the run's DatabaseCommandRunner port, which runs each in a workload container.
import { StepCode, type PlanRunResult, type Session } from "@revisum/contracts";
import { plan as planRun, resolve, targetUnavailable, type Planned } from "../lifecycle.ts";
import type { Logger } from "../logging.ts";
import { buildManifest, manifestHash } from "../manifest.ts";
import { assertBranded } from "../plan/plan-parser.ts";
import { assertCleared, type ClearedRun } from "../policy/ClearedRun.ts";
import { afterTheVerdict } from "./after-the-verdict/AfterTheVerdict.ts";
import {
    logFailureAfterTheVerdict,
    logKeepingTheResult,
    readKeepingTheResult,
    readRecord,
} from "./after-the-verdict/ReadKeepingTheResult.ts";
import { readValueOr, type RecordRead } from "./after-the-verdict/RecordRead.ts";
import { verdictGivenTheRecords } from "./after-the-verdict/RecordsAfterTheSteps.ts";
import { withRefusalsAfterTheVerdict } from "./after-the-verdict/WithRefusalsAfterTheVerdict.ts";
import type { SessionContext } from "./executors/StepExecutor.ts";
import type { StepsRun, StepsVerdict } from "./steps/VerdictOfSteps.ts";
import { checkPreflight, type PreflightPassed } from "./preflight/CheckPreflight.ts";
import { refuseRun } from "./preflight/RefuseRun.ts";
import type { RunContext, RunInputs, RunPorts } from "./RunContext.ts";
import { runLogging } from "./RunLogging.ts";
import { sealRanResult, type NothingRanContext } from "./seal/SealResult.ts";
import { unavailableResult } from "./seal/UnavailableResult.ts";
import { createRunContext } from "./session/CreateRunContext.ts";
import { manifestInputsOf, type ManifestInputs } from "./session/ManifestInputsOf.ts";
import { cannotPinDeterminism, type OpenedSession } from "./session/OpenSession.ts";
import { withOpenSession } from "./session/WithOpenSession.ts";
import { runTheSteps, stepsNotRunForTheLog } from "./steps/RunTheSteps.ts";
import { durationsOf, resultsOf } from "./steps/TimedStep.ts";

export async function runPlan(
    cleared: ClearedRun,
    inputs: RunInputs,
    ports: RunPorts,
): Promise<PlanRunResult> {
    // First, before any side effect: a run the gate did not clear, or a plan the parser did not make,
    // is refused, whatever its type says.
    assertCleared(cleared);
    assertBranded(cleared.plan);
    const { plan, target } = cleared;
    const startedAt = ports.clock.now();
    const preflight = checkPreflight({
        cleared,
        baseUrl: inputs.baseUrl,
        secretStore: ports.secrets,
        scriptSources: inputs.scriptSources ?? {},
        services: ports.services,
        databaseCommands: ports.databaseCommands,
    });
    const { redactor, logger } = runLogging(cleared, inputs.seed, ports, preflight.redaction);
    const isDeterminismUnpinned = cannotPinDeterminism(ports.drivers, target);
    const nothingRan: NothingRanContext = {
        subject: cleared,
        ports,
        logger,
        determinismUnpinned: isDeterminismUnpinned,
    };
    const planned = planRun(plan, target);
    // A log that fails this early ends the run Errored like one that fails later, once there are steps
    // to account for. It must not reject the run, and a refusal below still stands.
    const isPlanLogged = logKeepingTheResult(
        { kind: "run.state", state: planned.state, targetId: target.id },
        logger,
    );
    if (!preflight.outcome.ok) {
        return refuseRun(planned, preflight.outcome.error, nothingRan, startedAt);
    }
    const passed = preflight.outcome.value;
    const context = createRunContext(cleared, inputs, ports, passed, {
        redactor,
        logger,
        determinismUnpinned: isDeterminismUnpinned,
    });

    const inSession = await withOpenSession(planned, context, (opened) =>
        runTheStepsInTheSession(planned, context, passed, opened, isPlanLogged),
    );
    if (!inSession.ok) {
        const unavailable = targetUnavailable(planned, inSession.error);
        return unavailableResult(target.id, unavailable.unavailable, nothingRan, startedAt);
    }
    return finishAfterTheSteps(inSession.value, context, nothingRan, startedAt);
}

// What the steps leave once the session has closed.
type StepsInTheSession = {
    readonly session: Session;
    readonly manifestInputs: ManifestInputs;
    readonly ran: StepsRun;
};

// The manifest as it stands before the steps, and the steps, while the session is open.
async function runTheStepsInTheSession(
    planned: Planned,
    context: RunContext,
    passed: PreflightPassed,
    opened: OpenedSession,
    isPlanLogged: boolean,
): Promise<StepsInTheSession> {
    const { session, driver } = opened;
    const manifestInputs = manifestInputsOf(context, passed, opened);
    const manifestBeforeTheSteps = buildManifest(manifestInputs);
    const resolved = resolve(
        planned,
        session,
        manifestBeforeTheSteps,
        manifestHash(manifestBeforeTheSteps),
    );
    const stepContext: SessionContext = { ...context, session };
    const ran = isPlanLogged
        ? await runTheSteps(stepContext, resolved, driver.info.id)
        : stepsNotRunForTheLog(stepContext, resolved);
    return { session, manifestInputs, ran };
}

// The verdict, what comes after it, and the seal.
async function finishAfterTheSteps(
    inSession: StepsInTheSession,
    context: RunContext,
    nothingRan: NothingRanContext,
    startedAt: number,
): Promise<PlanRunResult> {
    const { session, manifestInputs, ran } = inSession;
    const { logger, ports } = context;
    const refusals = refusalsAfterTheVerdict(session, logger);
    const readBeforeTheEgress = {
        refusals,
        rewrites: ran.rewrites,
        stubAnswers: ran.stubAnswers,
    };
    const verdict = verdictAfterRefusals(
        verdictGivenTheRecords(ran, readBeforeTheEgress),
        readValueOr(refusals, []),
        logger,
    );
    const after = await afterTheVerdict({ ...context, session }, verdict);
    const rewrites = readValueOr(ran.rewrites, []);
    const manifest =
        rewrites.length === 0
            ? verdict.finished.manifest
            : buildManifest({ ...manifestInputs, responseRewrites: rewrites });
    const beforeTheDenial = {
        targetId: context.cleared.target.id,
        manifest,
        manifestHash: manifestHash(manifest),
        steps: resultsOf(verdict.steps),
        unavailable: null,
    };
    const afterTheDenial = {
        ...(after.cleanup === undefined ? {} : { cleanup: after.cleanup }),
        ...(after.cleanupReviewItems.length === 0 ? {} : { reviewItems: after.cleanupReviewItems }),
        timings: {
            totalMilliseconds: readKeepingTheResult(() => ports.clock.now() - startedAt, 0, logger),
            stepMilliseconds: durationsOf(verdict.steps),
        },
    };
    const { end } = after;
    // A result's key order is published: the denial stands between the steps and the cleanup.
    const outcome =
        "denial" in end
            ? { state: end.state, ...beforeTheDenial, denial: end.denial, ...afterTheDenial }
            : { state: end.state, ...beforeTheDenial, ...afterTheDenial };
    return sealRanResult(outcome, nothingRan, { ...readBeforeTheEgress, egress: after.egress });
}

// The request decisions the browser refused, read once the session has closed, each logged.
function refusalsAfterTheVerdict(session: Session, logger: Logger): RecordRead<readonly string[]> {
    const refusals = readRecord(() => session.refusedRequestDecisions(), logger);
    for (const refusal of readValueOr(refusals, [])) {
        logFailureAfterTheVerdict(StepCode.AdapterError, refusal, logger);
    }
    return refusals;
}

// The verdict with the refusals read after it counted. A step they spoilt ends again in the log, as it
// now does in the result, so the log alone never shows a pass where the result says the run could
// not test.
function verdictAfterRefusals(
    verdict: StepsVerdict,
    refusals: readonly string[],
    logger: Logger,
): StepsVerdict {
    const counted = withRefusalsAfterTheVerdict(verdict, refusals);
    if (counted.isSpoilt) {
        const { spoiltStep, spoiltStepMilliseconds } = counted;
        logKeepingTheResult(
            {
                kind: "step.end",
                stepIndex: spoiltStep.index,
                stepType: spoiltStep.type,
                outcome: spoiltStep.outcome,
                durationMilliseconds: spoiltStepMilliseconds,
                code: spoiltStep.code,
            },
            logger,
        );
    }
    return counted.verdict;
}
