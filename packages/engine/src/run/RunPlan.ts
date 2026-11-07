// The deterministic interpreter: (plan, target, ports) to RunResult. It accepts only a plan the
// parser made and the policy gate authorised, walks the typed lifecycle, never substitutes a
// target, and hashes everything except wall-clock timings. Declared service calls go through the
// run's ServiceCaller port; a failed call ends the run Errored, since it could not test, and the
// plan's cleanup calls run after the steps whatever the outcome. Stubs, request checks and web
// storage go through the session's network and storage ports; clock advances and clipboard reads
// through its clock and clipboard ports; page scripts through its script port. Database commands
// go through the run's DatabaseCommandRunner port, which runs each in a workload container.
import { StepCode, type Session } from "@revisum/contracts";
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
} from "./after-the-verdict/ReadKeepingTheResult.ts";
import { withRefusalsAfterTheVerdict } from "./after-the-verdict/WithRefusalsAfterTheVerdict.ts";
import type { SessionContext } from "./executors/StepExecutor.ts";
import { checkPreflight, type PreflightPassed } from "./preflight/CheckPreflight.ts";
import { refuseRun } from "./preflight/RefuseRun.ts";
import type { RunContext, RunInputs, RunPorts } from "./RunContext.ts";
import { runLogging } from "./RunLogging.ts";
import type { RunResult } from "./RunResult.ts";
import { sealResult, type NothingRanContext } from "./seal/SealResult.ts";
import { unavailableResult } from "./seal/UnavailableResult.ts";
import { createRunContext } from "./session/CreateRunContext.ts";
import { manifestInputsOf } from "./session/ManifestInputsOf.ts";
import { cannotPinDeterminism, openSession, type OpenedSession } from "./session/OpenSession.ts";
import { runTheSteps } from "./steps/RunTheSteps.ts";

export async function runPlan(
    cleared: ClearedRun,
    inputs: RunInputs,
    ports: RunPorts,
): Promise<RunResult> {
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

    const opened = await openSession(planned, context);
    if (!opened.ok) {
        const unavailable = targetUnavailable(planned, opened.error);
        return unavailableResult(target.id, unavailable.unavailable, nothingRan, startedAt);
    }
    return runInTheSession({
        planned,
        context,
        passed,
        opened: opened.value,
        nothingRan,
        startedAt,
        isPlanLogged,
    });
}

// A run whose session opened, and what it brings from before.
type OpenedRun = {
    readonly planned: Planned;
    readonly context: RunContext;
    readonly passed: PreflightPassed;
    readonly opened: OpenedSession;
    readonly nothingRan: NothingRanContext;
    readonly startedAt: number;
    readonly isPlanLogged: boolean;
};

// The steps, their verdict, what comes after it, and the seal.
async function runInTheSession(run: OpenedRun): Promise<RunResult> {
    const { context, opened, startedAt } = run;
    const { logger, ports } = context;
    const { session, driver } = opened;
    const stepContext: SessionContext = { ...context, session };
    const manifestInputs = manifestInputsOf(context, run.passed, opened);
    const manifestBeforeTheSteps = buildManifest(manifestInputs);
    const resolved = resolve(
        run.planned,
        session,
        manifestBeforeTheSteps,
        manifestHash(manifestBeforeTheSteps),
    );
    const ran = await runTheSteps(stepContext, resolved, driver.info.id, run.isPlanLogged);
    const verdict = withRefusalsAfterTheVerdict(ran, refusalsAfterTheVerdict(session, logger));
    const after = await afterTheVerdict(stepContext, verdict);
    const manifest =
        ran.rewrites.length === 0
            ? verdict.finished.manifest
            : buildManifest({ ...manifestInputs, responseRewrites: ran.rewrites });
    return sealResult(
        {
            state: after.endState.state,
            targetId: context.cleared.target.id,
            manifest,
            manifestHash: manifestHash(manifest),
            steps: verdict.steps,
            blockedOrigins: after.blocked,
            unavailable: null,
            ...(verdict.finished.state === "Denied" ? { denial: verdict.finished.denial } : {}),
            ...(after.cleanup === undefined ? {} : { cleanup: after.cleanup }),
            ...(after.reviewItems.length === 0 ? {} : { reviewItems: after.reviewItems }),
            ...(ran.stubAnswers.length === 0 ? {} : { stubAnswers: [...ran.stubAnswers] }),
            timings: {
                totalMilliseconds: readKeepingTheResult(
                    () => ports.clock.now() - startedAt,
                    0,
                    logger,
                ),
                stepMilliseconds: ran.stepMilliseconds,
            },
        },
        run.nothingRan,
    );
}

// The request decisions the browser refused, read once the session has closed, each logged.
function refusalsAfterTheVerdict(session: Session, logger: Logger): readonly string[] {
    const refusals: readonly string[] = readKeepingTheResult(
        () => session.refusedRequestDecisions(),
        [],
        logger,
    );
    for (const refusal of refusals) {
        logFailureAfterTheVerdict(StepCode.AdapterError, refusal, logger);
    }
    return refusals;
}
