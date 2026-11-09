// The composition root: the one file in the packages that builds the adapters a command runs with
// and hands them in, so a command gets finished ports and no caller can open a browser without its
// egress proxy. tools/repo-rules/code/CheckCompositionRoot.ts keeps it the only one.
import {
    cdpDriver,
    egressThroughExistingProxy,
    parseProxyServer,
    type EgressSource,
    type OwnBrowserDriver,
} from "@revisum/driver-cdp";
import {
    createRunService,
    defaultRedactor,
    environmentSecretStore,
    failure,
    HOST_ISOLATION,
    RunnerErrorCode,
    sha256,
    success,
    UnavailableReason,
    unwiredPorts,
    withDeclaredSecretRedaction,
    type ArtifactReference,
    type ArtifactStore,
    type BrowserDriver,
    type Clock,
    type ClosedSession,
    type DraftRequest,
    type EventSink,
    type PlannerEndpoint,
    type Redactor,
    type Result,
    type RunEventSink,
    type RunService,
    type SecretName,
    type SecretStore,
    type Session,
} from "@revisum/engine";
import {
    NO_IMAGE,
    parseProxyRules,
    ProxyClient,
    readBrowserRefusals,
    serviceCaller,
    startProxyServer,
    type AddressConnector,
    type AddressResolver,
    type EgressProxy,
} from "@revisum/runner";
import type { DraftCommandPorts, PlannerCall } from "../commands/DraftCommand.ts";
import type { IsolatedRunner, LoginRunner } from "../explore/CrawlInBrowser.ts";
import { plannerAdapter } from "../planners/PlannerAdapter.ts";
import type { SuiteRunPorts } from "../commands/RunSuite.ts";

// A host run's session goes through its own proxy. Only host runs allow declared private addresses,
// so internal staging and localhost keep working, and every other address is refused.
export const startHostSessionEgress: EgressSource = async (allowedOrigins) => {
    const rules = parseProxyRules({
        allowedOrigins,
        privateOrigins: allowedOrigins,
        rewrites: [],
    });
    if (!rules.ok) {
        return failure(rules.error.message);
    }
    const started = await startProxyServer(rules.value, { client: ProxyClient.Browser });
    if (!started.ok) {
        return failure(started.error.message);
    }
    const proxy = started.value;
    return success({
        proxy: { server: proxy.url, includeLoopback: true },
        refusedOrigins: () => success(proxy.refusedOrigins()),
        // A listener's failure belongs to no declared origin, so it is named after the proxy.
        connectionFailures: () => [
            ...proxy.connectionFailures(),
            ...proxy.listenerFailures().map((failure) => ({
                origin: proxy.url,
                message: `A listener of the egress proxy failed, so its record may be incomplete: ${failure.message}`,
            })),
        ],
        close: async () => {
            const closed = await proxy.close();
            return closed.ok ? success(undefined) : failure(closed.error.message);
        },
    });
};

// How a planner call reaches the network, with the store its key is read from. `resolve` and
// `connect` are handed to the egress proxy, which resolves and connects for real without them;
// `trustedCertificates` are PEM certificates trusted for HTTPS besides the system's own.
export type PlannerNetwork = {
    readonly secrets: SecretStore;
    readonly resolve?: AddressResolver | undefined;
    readonly connect?: AddressConnector | undefined;
    readonly trustedCertificates?: readonly string[] | undefined;
};

type PlannerAnswer =
    | { readonly kind: "answered"; readonly reply: unknown }
    | { readonly kind: "secret-missing" }
    | { readonly kind: "call-failed" };

// The planner's reply through a running proxy, or why there is none.
async function askPlanner(
    endpoint: PlannerEndpoint,
    request: DraftRequest,
    network: PlannerNetwork,
    proxy: Pick<EgressProxy, "url">,
): Promise<PlannerAnswer> {
    const caller = serviceCaller({ proxy, trustedCertificates: network.trustedCertificates });
    const adapter = plannerAdapter(endpoint, { caller, secrets: network.secrets });
    if (!adapter.ok) {
        return { kind: "secret-missing" };
    }
    const drafted = await adapter.value.draft(request);
    // The code tells a person nothing that the failure itself does not, so none of it is shown.
    return drafted.ok ? { kind: "answered", reply: drafted.value } : { kind: "call-failed" };
}

// What went wrong with the planner's proxy while it ran and as it closed, or null if nothing did. The
// reply stands either way, but a person should know the proxy's record may be incomplete.
function plannerProxyFailure(
    proxy: Pick<EgressProxy, "listenerFailures">,
    closed: Awaited<ReturnType<EgressProxy["close"]>>,
): string | null {
    const failures = [
        ...proxy
            .listenerFailures()
            .map(
                (failure) => `a listener of the planner's egress proxy failed: ${failure.message}`,
            ),
        ...(closed.ok ? [] : [`the planner's egress proxy did not close: ${closed.error.message}`]),
    ];
    return failures.length === 0 ? null : failures.join("; ");
}

// Each planner call goes through an egress proxy of its own that allows only the planner's origin,
// and is closed either way, even when the call hits a programming error, which still rejects. A local
// endpoint is a private service on loopback; any other must resolve to a public address.
const plannerCallThroughItsOwnProxy =
    (network: PlannerNetwork): PlannerCall =>
    async (endpoint, request) => {
        const { origin } = endpoint;
        const rules = parseProxyRules({
            allowedOrigins: [origin],
            privateOrigins: endpoint.kind === "local" ? [origin] : [],
            rewrites: [],
        });
        if (!rules.ok) {
            return { kind: "proxy-failed", failure: rules.error };
        }
        const started = await startProxyServer(rules.value, {
            resolve: network.resolve,
            connect: network.connect,
        });
        if (!started.ok) {
            return { kind: "proxy-failed", failure: started.error };
        }
        const proxy = started.value;
        let answered: PlannerAnswer;
        try {
            answered = await askPlanner(endpoint, request, network, proxy);
        } catch (programmingError) {
            throw errorAfterClosing(
                programmingError,
                plannerProxyFailure(proxy, await proxy.close()),
            );
        }
        const closed = await proxy.close();
        return { ...answered, closeFailure: plannerProxyFailure(proxy, closed) };
    };

// The error as it was thrown, or, when the proxy also failed to close, one saying both.
function errorAfterClosing(error: unknown, closeFailure: string | null): unknown {
    if (closeFailure === null) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message}; ${closeFailure}`, { cause: error });
}

const systemClock: Clock = {
    now: () => Date.now(),
    sleep: (milliseconds) =>
        new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
        }),
};

const discardingAudit: EventSink = { append: () => success({ sequence: 0 }) };

// A run whose output nobody reads, such as a login before a crawl or a benchmark, keeps nothing.
const discardingArtifacts: ArtifactStore = {
    put: (name, bytes, mediaType): Promise<ArtifactReference> =>
        Promise.resolve({ name, mediaType, sha256: sha256(bytes), bytes: bytes.length }),
};

const discardingRunEvents: RunEventSink = { append: () => undefined, read: () => [] };

// What the login run is told when its close leaves the crawl's session open: what the session has
// noted by then. Only the run's state is read, and the crawl goes on using the session after it.
const keptOpen = (session: Session): Promise<ClosedSession> =>
    Promise.resolve({ ...session.recordsSoFar(), closeFailure: null });

// A driver that hands the run the crawl's own session instead of opening another, and keeps it open
// when the run ends. The run opens only its cleared target, the one the session was opened for.
function driverOnTheCrawlSession(browser: BrowserDriver, session: Session): BrowserDriver {
    const shared = new Proxy(session, {
        get: (target, property): unknown => {
            if (property === "close") {
                return () => keptOpen(session);
            }
            const value: unknown = Reflect.get(target, property);
            // A class's private state is reachable only with the instance itself as `this`.
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return {
        info: browser.info,
        supports: (target) => browser.supports(target),
        open: () => Promise.resolve(success(shared)),
    };
}

// The --after run, in the crawl's session, writing no result file.
const loginInTheCrawlSession: LoginRunner = (onItsSession, inputs) => {
    const { browser, redactor, secrets, audit } = onItsSession.shared();
    return createRunService({
        ...unwiredPorts,
        drivers: new Map([
            [
                onItsSession.login.target.adapter,
                driverOnTheCrawlSession(browser, onItsSession.session),
            ],
        ]),
        clock: systemClock,
        artifacts: discardingArtifacts,
        redactor,
        events: discardingRunEvents,
        audit,
        secrets,
        isolation: HOST_ISOLATION,
    }).run(onItsSession.login, inputs);
};

// A command given no browser says so for every target, so it stops the way any target it cannot
// drive stops, and needs no branch of its own.
const WHY_NO_BROWSER = {
    reason: UnavailableReason.AdapterNotRegistered,
    detail: "this command was given no browser",
};
const NO_BROWSER: BrowserDriver = {
    info: { id: "no-browser", version: "none", protocol: "none" },
    supports: () => failure(WHY_NO_BROWSER),
    open: () => Promise.resolve(failure(WHY_NO_BROWSER)),
};

// A command given no isolated runner has it refuse every run, having started nothing.
const NO_ISOLATED_RUNNER: IsolatedRunner = {
    runner: { withRun: () => Promise.resolve(failure({ code: RunnerErrorCode.StartFailed })) },
    image: NO_IMAGE,
};

export type BenchmarkPorts = {
    // A run service for one sample, whose steps its own event sink times.
    runService(events: RunEventSink): RunService;
    readonly audit: EventSink;
};

export type ContainerCrawlPorts = {
    readonly browser: OwnBrowserDriver;
    readonly secrets: SecretStore;
    readonly redactor: Redactor;
    // The container keeps no audit log of its own: the host recorded the gate's decision already.
    readonly audit: EventSink;
    readonly runLogin: LoginRunner;
};

// What the draft command's ports cannot be built without. `executablePath` is the browser for --host,
// and with none the command's browser says it is absent.
export type DraftCommandNeeds = Pick<
    DraftCommandPorts,
    "workingDirectory" | "secrets" | "events" | "versionControl" | "planner"
> & { readonly executablePath?: string | undefined };

// What only an explicit override can change, in plain sight.
export type DraftCommandOverrides = Partial<
    Pick<DraftCommandPorts, "redactor" | "runLogin" | "browser" | "isolatedRunner" | "approvals">
>;

export type SuiteRunNeeds = Omit<SuiteRunPorts, "redactor">;
export type SuiteRunOverrides = Partial<Pick<SuiteRunPorts, "redactor">>;

export const buildAdapters = {
    hostBrowserDriver({ executablePath }: { readonly executablePath: string }): OwnBrowserDriver {
        return cdpDriver({ executablePath, egress: startHostSessionEgress });
    },

    containerBrowserDriver({
        executablePath,
        proxyServer,
    }: {
        readonly executablePath: string;
        readonly proxyServer: string;
    }): OwnBrowserDriver {
        return cdpDriver({
            executablePath,
            // Everything but the container's own loopback goes through the run's egress proxy, which
            // is in another container, along with what it refused.
            egress: egressThroughExistingProxy(proxyServer, () => readBrowserRefusals(proxyServer)),
        });
    },

    plannerCalls: plannerCallThroughItsOwnProxy,

    loginRunner: loginInTheCrawlSession,

    draftCommandPorts(
        { executablePath, ...needs }: DraftCommandNeeds,
        overrides: DraftCommandOverrides = {},
    ): DraftCommandPorts {
        return {
            ...needs,
            redactor: defaultRedactor(),
            runLogin: loginInTheCrawlSession,
            browser:
                executablePath === undefined
                    ? NO_BROWSER
                    : buildAdapters.hostBrowserDriver({ executablePath }),
            isolatedRunner: NO_ISOLATED_RUNNER,
            ...overrides,
        };
    },

    suiteRunPorts(needs: SuiteRunNeeds, overrides: SuiteRunOverrides = {}): SuiteRunPorts {
        return { ...needs, redactor: defaultRedactor(), ...overrides };
    },

    // The run's egress proxy is the crawl's only way out, so whether HTTP_PROXY names one is settled
    // here, before any browser is built. Only the declared secrets are read from the environment.
    containerCrawlPorts({
        executablePath,
        secretNames,
        environment,
    }: {
        readonly executablePath: string;
        readonly secretNames: readonly SecretName[];
        readonly environment: NodeJS.ProcessEnv;
    }): Result<ContainerCrawlPorts, "no-egress-proxy"> {
        const proxyServer = parseProxyServer(environment["HTTP_PROXY"]?.trim() ?? "");
        if (!proxyServer.ok) {
            return failure("no-egress-proxy");
        }
        const secrets = environmentSecretStore(
            Object.fromEntries(secretNames.map((name) => [name, environment[name]])),
        );
        return success({
            browser: buildAdapters.containerBrowserDriver({
                executablePath,
                proxyServer: proxyServer.value,
            }),
            secrets,
            redactor: withDeclaredSecretRedaction(defaultRedactor(), secretNames, secrets),
            audit: discardingAudit,
            runLogin: loginInTheCrawlSession,
        });
    },

    benchmarkPorts({ executablePath }: { readonly executablePath: string }): BenchmarkPorts {
        const drivers = new Map([["cdp", buildAdapters.hostBrowserDriver({ executablePath })]]);
        return {
            audit: discardingAudit,
            runService: (events) =>
                createRunService({
                    ...unwiredPorts,
                    drivers,
                    clock: systemClock,
                    artifacts: discardingArtifacts,
                    redactor: defaultRedactor(),
                    audit: discardingAudit,
                    events,
                    isolation: HOST_ISOLATION,
                }),
        };
    },
};
