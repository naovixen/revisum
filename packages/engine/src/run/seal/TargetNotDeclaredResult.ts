// The result of a target the gate gave no cleared run, since the plan or the project's matrix does
// not declare it: TargetUnavailable with not-declared, before any driver is asked. It is logged and
// sealed as any run that never opened its target is.
import { UnavailableReason } from "@revisum/contracts";
import type { TargetNotDeclared } from "../../policy/TargetNotDeclared.ts";
import { secretsToRedact } from "../preflight/CheckPreflight.ts";
import type { RunPorts } from "../RunContext.ts";
import { runLogging } from "../RunLogging.ts";
import type { RunResult } from "../RunResult.ts";
import { cannotPinDeterminism } from "../session/OpenSession.ts";
import type { NothingRanContext } from "./SealResult.ts";
import { unavailableResult } from "./UnavailableResult.ts";

export function targetNotDeclaredResult(
    notDeclared: TargetNotDeclared,
    seed: number,
    ports: RunPorts,
): RunResult {
    const startedAt = ports.clock.now();
    const { logger } = runLogging(
        notDeclared,
        seed,
        ports,
        secretsToRedact(notDeclared, ports.secrets, ports.databaseCommands),
    );
    const target = notDeclared.project.matrix.find(
        (candidate) => candidate.id === notDeclared.targetId,
    );
    const nothingRan: NothingRanContext = {
        subject: notDeclared,
        ports,
        logger,
        determinismUnpinned: target !== undefined && cannotPinDeterminism(ports.drivers, target),
    };
    const unavailable = {
        reason: UnavailableReason.NotDeclared,
        detail: "target is not in both the plan and the matrix",
    };
    return unavailableResult(notDeclared.targetId, unavailable, nothingRan, startedAt);
}
