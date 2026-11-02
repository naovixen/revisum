// The public types every package shares, pinned here so a change to one fails `tsc`. This file is
// type-checked by type-check.test.ts, shared-types.test.ts and SharedTypePins.test.ts, and never run. A name that is gone
// fails its export below; a shape that changes fails its pin, whose `Same` no longer gives true.
import type {
    A11yFinding,
    A11yNode,
    ActorId,
    ActorType,
    AllowedUrl,
    ArtifactReference,
    AuditEventKind,
    Auditor,
    Box,
    Brand,
    Camera,
    DerivedActor,
    DriverError,
    DriverErrorCode,
    ElementProbe,
    EventInput,
    EventSink,
    Failure,
    GuaranteeLevel,
    Impact,
    Locale,
    Origin,
    PageNavigator,
    PageProbe,
    PERSON_ACTOR_TYPES,
    Prober,
    RecorderError,
    Result,
    Role,
    ROLES,
    RunnerError,
    SafeText,
    SinkError,
    Success,
    success,
    failure,
    TargetId,
    ThresholdMetric,
    Thresholds,
} from "@revisum/engine";

export type {
    ActionRunner,
    ActionStep,
    CliErrorCode,
    ElementAssertion,
    FixtureReference,
    Locator,
    PageAssertion,
    PlanErrorCode,
    RunRecord,
    Session,
} from "@revisum/engine";

// True only when the two types are identical, not merely assignable either way.
type Same<Left, Right> =
    (<Probe>() => Probe extends Left ? 1 : 2) extends <Probe>() => Probe extends Right ? 1 : 2
        ? true
        : false;
type Pinned<IsSame extends true> = IsSame;

type Primitives = [
    Pinned<Same<Brand<string, "Name">, string & { readonly __brand: "Name" }>>,
    Pinned<Same<Success<string>, { readonly ok: true; readonly value: string }>>,
    Pinned<Same<Failure<number>, { readonly ok: false; readonly error: number }>>,
    Pinned<Same<Result<string, number>, Success<string> | Failure<number>>>,
    Pinned<Same<ReturnType<typeof success<string>>, Success<string>>>,
    Pinned<Same<ReturnType<typeof failure<number>>, Failure<number>>>,
    Pinned<Same<Origin, Brand<string, "Origin">>>,
    Pinned<Same<AllowedUrl, Brand<string, "AllowedUrl">>>,
    Pinned<Same<SafeText, Brand<string, "SafeText">>>,
    Pinned<Same<TargetId, Brand<string, "TargetId">>>,
    Pinned<Same<Locale, Brand<string, "Locale">>>,
    Pinned<Same<Role, (typeof ROLES)[number]>>,
    Pinned<Same<GuaranteeLevel, "isolated" | "host">>,
];

type StoredThings = [
    Pinned<
        Same<
            Box,
            {
                readonly x: number;
                readonly y: number;
                readonly width: number;
                readonly height: number;
            }
        >
    >,
    Pinned<
        Same<
            ArtifactReference,
            {
                readonly name: string;
                readonly mediaType: string;
                readonly sha256: string;
                readonly bytes: number;
            }
        >
    >,
];

type Accessibility = [
    Pinned<Same<Impact, "minor" | "moderate" | "serious" | "critical" | "unknown">>,
    Pinned<
        Same<
            A11yFinding,
            { readonly ruleId: string; readonly impact: Impact; readonly elementCount: number }
        >
    >,
    Pinned<
        Same<
            A11yNode,
            {
                readonly role: string;
                readonly name: string;
                readonly children: readonly A11yNode[];
            }
        >
    >,
];

// A port losing or gaining a method is a change for every driver, so each port's methods are pinned.
type DriverPorts = [
    Pinned<Same<keyof PageNavigator, "navigate" | "page">>,
    Pinned<Same<keyof Prober, "probe">>,
    Pinned<Same<keyof Camera, "screenshot" | "screenshotHidingFields">>,
    Pinned<Same<keyof Auditor, "audit" | "accessibilitySnapshot">>,
    Pinned<
        Same<Pick<PageProbe, "url" | "title">, { readonly url: string; readonly title: string }>
    >,
    Pinned<
        Same<
            ElementProbe["count"],
            number | "page-unreadable" | "dialog-open" | "navigation-failed"
        >
    >,
    Pinned<Same<DriverError, { readonly code: DriverErrorCode; readonly detail: string }>>,
];

type ActorsAndEvents = [
    Pinned<Same<ActorId, Brand<string, "ActorId">>>,
    Pinned<Same<ActorType, "person-verified" | "person-declared" | "agent" | "ci" | "unverified">>,
    Pinned<Same<typeof PERSON_ACTOR_TYPES, readonly ActorType[]>>,
    Pinned<
        Same<
            DerivedActor,
            Brand<{ readonly actor: ActorId; readonly actorType: ActorType }, "DerivedActor">
        >
    >,
    Pinned<
        Same<
            AuditEventKind,
            | "plan.submitted"
            | "plan.rejected"
            | "plan.denied"
            | "plan.approved"
            | "approval.refused"
            | "trusted.changed-with-code"
            | "run.finished"
            | "review.decided"
            | "severity.overridden"
            | "adapter.admitted"
            | "pack.admitted"
            | "check.removed"
            | "tracker.changed"
            | "holdout.access-refused"
        >
    >,
    Pinned<Same<EventInput["kind"], AuditEventKind>>,
    Pinned<Same<ReturnType<EventSink["append"]>, Result<{ readonly sequence: number }, SinkError>>>,
    Pinned<Same<Parameters<EventSink["append"]>, [event: EventInput, actor: DerivedActor]>>,
];

type ThresholdsAndFailures = [
    Pinned<
        Same<
            ThresholdMetric,
            | "agentAuthoredShare"
            | "specLinkedShare"
            | "tracedCriteriaShare"
            | "mutantsCaughtShare"
            | "verifiedWithoutReviewShare"
            | "unreviewedMergeShare"
            | "flakyRunRate"
        >
    >,
    Pinned<Same<Pick<Thresholds, ThresholdMetric>, Readonly<Record<ThresholdMetric, number>>>>,
    Pinned<Same<Thresholds["windows"], number>>,
    Pinned<Same<Thresholds["minimumChangesPerWindow"], number>>,
    Pinned<
        Same<
            RunnerError,
            {
                readonly code:
                    | "image-missing"
                    | "image-digest-mismatch"
                    | "egress-unenforceable"
                    | "start-failed";
            }
        >
    >,
    Pinned<
        Same<
            RecorderError,
            {
                readonly code: "no-reason" | "unknown-item" | "already-decided" | "sink-failed";
            }
        >
    >,
    Pinned<Same<SinkError, { readonly code: "not-append-only" | "write-failed" }>>,
];

export type SharedTypePins = [
    Primitives,
    StoredThings,
    Accessibility,
    DriverPorts,
    ActorsAndEvents,
    ThresholdsAndFailures,
];
