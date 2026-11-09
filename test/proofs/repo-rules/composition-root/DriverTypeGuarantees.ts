// Compile-time guarantees around what a driver is handed. Type-checked by
// DriverTypeGuarantees.test.ts, never run.
//   - A driver's ports take only resolved steps: a plan step, download step, dialog step or locator,
//     any of which may still hold a value reference, does not type-check as one.
//   - A fill of a secret carries the secret itself: a fill naming a secret it does not carry, and a
//     secret handed beside the action, do not type-check.
// Each @ts-expect-error line must stay an error; the test deletes them to prove it.
import type {
    ActionGuard,
    ActionStep,
    DialogStep,
    DocumentSession,
    DownloadStep,
    Locator,
    PerformableAction,
    ResolvedDownloadStep,
    ResolvedLocator,
    Secret,
    SecretName,
} from "@revisum/engine";

declare const session: DocumentSession;
declare const guard: ActionGuard;
declare const performable: PerformableAction;
declare const resolvedLocator: ResolvedLocator;
declare const resolvedDownload: ResolvedDownloadStep;
declare const planStep: Exclude<ActionStep, DownloadStep>;
declare const planDialog: DialogStep;
declare const planDownload: DownloadStep;
declare const planLocator: Locator;
declare const secret: Secret;
declare const secretName: SecretName;

// What a driver is handed, each of which type-checks.
export const driverTypeGuarantees = {
    performableActs: session.act(performable, guard),
    secretFillActs: session.act(
        { type: "fill", locator: resolvedLocator, value: { kind: "secret", secret } },
        guard,
    ),
    resolvedDownloadRuns: session.download(resolvedDownload, 100, guard),
    resolvedLocatorIsProbed: session.probe(resolvedLocator, null),
};

// @ts-expect-error a plan step, which may still hold a value reference, cannot reach a driver
export const planStepActs = session.act(planStep, guard);

// @ts-expect-error a dialog step whose expected text may be a value reference cannot reach a driver
export const planDialogActs = session.act(planDialog, guard);

export const secretReferenceFillActs = session.act(
    // @ts-expect-error a fill naming a secret it does not carry cannot reach a driver
    { type: "fill", locator: resolvedLocator, value: { kind: "secret", secretName } },
    guard,
);

// @ts-expect-error a secret is carried on its fill, never handed beside the action
export const secretBesideTheAction = session.act(performable, guard, secret);

// @ts-expect-error a download step whose locator may hold a value reference cannot reach a driver
export const planDownloadRuns = session.download(planDownload, 100, guard);

// @ts-expect-error a locator that may hold a value reference cannot be probed
export const planLocatorIsProbed = session.probe(planLocator, null);
