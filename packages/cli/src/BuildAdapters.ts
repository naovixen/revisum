// The composition root: the one file in the packages that builds the adapters a command runs with
// and hands them in, so a command gets finished ports and no caller can open a browser without its
// egress proxy. tools/CheckCompositionRoot.ts keeps it the only one.
import {
    cdpDriver,
    egressThroughExistingProxy,
    type EgressSource,
    type OwnBrowserDriver,
} from "@revisum/driver-cdp";
import {
    createRunService,
    defaultRedactor,
    environmentSecretStore,
    failure,
    HOST_ISOLATION,
    sha256,
    success,
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
    type RunEventSink,
    type RunService,
    type SecretName,
    type SecretStore,
    type Session,
    type VersionControlPort,
} from "@revisum/engine";
import {
    parseProxyRules,
    ProxyClient,
    readBrowserRefusals,
    serviceCaller,
    startProxyServer,
    type AddressConnector,
    type AddressResolver,
    type EgressProxy,
} from "@revisum/runner";
import type { PlannerCall } from "./draft-command.ts";
import type { LoginRunner } from "./explore-crawl.ts";
import { plannerAdapter } from "./planner-adapters.ts";

// A host run's session goes through its own proxy. Only host runs allow declared private addresses,
// so internal staging and localhost keep working, and every other address is refused. A source says
// it failed by rejecting, which the driver turns into its own outcome.
export const startHostSessionEgress: EgressSource = async (allowedOrigins) => {
    const rules = parseProxyRules({
        allowedOrigins,
        privateOrigins: allowedOrigins,
        rewrites: [],
    });
    if (!rules.ok) {
        throw new Error(rules.error.message);
    }
    const started = await startProxyServer(rules.value, { client: ProxyClient.Browser });
    if (!started.ok) {
        throw new Error(started.error.message);
    }
    const proxy = started.value;
    return {
        proxy: { server: proxy.url, includeLoopback: true },
        refusedOrigins: () => proxy.refusedOrigins(),
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
            if (!closed.ok) {
                throw new Error(closed.error.message);
            }
        },
    };
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
    try {
        return { kind: "answered", reply: await adapter.value.draft(request) };
    } catch {
        // The adapter's error carries only a code, and none of it is shown: the failure is enough.
        return { kind: "call-failed" };
    }
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
// and is closed either way. A local endpoint is a private service on loopback; any other must resolve
// to a public address.
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
        const answered = await askPlanner(endpoint, request, network, proxy);
        const closed = await proxy.close();
        return { ...answered, closeFailure: plannerProxyFailure(proxy, closed) };
    };

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
        get: (target, property): unknown =>
            property === "close" ? () => keptOpen(session) : Reflect.get(target, property),
    });
    return {
        info: browser.info,
        supports: (target) => browser.supports(target),
        open: () => Promise.resolve(success(shared)),
    };
}

// The --after run, in the crawl's session, writing no result file.
const loginInTheCrawlSession: LoginRunner = (login, onSession, inputs) =>
    createRunService({
        ...unwiredPorts,
        drivers: new Map([
            [login.target.adapter, driverOnTheCrawlSession(onSession.browser, onSession.session)],
        ]),
        clock: systemClock,
        artifacts: discardingArtifacts,
        redactor: onSession.redactor,
        events: discardingRunEvents,
        audit: onSession.audit,
        secrets: onSession.secrets,
        isolation: HOST_ISOLATION,
    }).run(login, inputs);

// A protected branch holding only the one project file, for the benchmark, so its project is trusted
// the way core trusts any project.
const protectedBranchHolding = (projectFile: unknown): VersionControlPort => ({
    protectedBranch: "main",
    protectedFile: (path) =>
        Promise.resolve(
            path === "project.json"
                ? success({
                      bytes: new TextEncoder().encode(JSON.stringify(projectFile)),
                      commit: "benchmark",
                  })
                : failure("not-found"),
        ),
    reviews: () => Promise.resolve(failure("unavailable")),
    changedFiles: () => Promise.resolve(failure("unavailable")),
    pullRequest: () => Promise.resolve(failure("unavailable")),
    lastCommitTouching: () => Promise.resolve(failure("unavailable")),
    landedBy: () => Promise.resolve(failure("unavailable")),
});

export type BenchmarkPorts = {
    // A run service for one sample, whose steps its own event sink times.
    runService(events: RunEventSink): RunService;
    readonly audit: EventSink;
    protectedBranchHolding(projectFile: unknown): VersionControlPort;
};

export type ContainerCrawlPorts = {
    readonly browser: OwnBrowserDriver;
    readonly secrets: SecretStore;
    readonly redactor: Redactor;
    // The container keeps no audit log of its own: the host recorded the gate's decision already.
    readonly audit: EventSink;
    readonly runLogin: LoginRunner;
};

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

    // Only the declared secrets are read from the container's environment.
    containerCrawlPorts({
        executablePath,
        proxyServer,
        secretNames,
        environment,
    }: {
        readonly executablePath: string;
        readonly proxyServer: string;
        readonly secretNames: readonly SecretName[];
        readonly environment: NodeJS.ProcessEnv;
    }): ContainerCrawlPorts {
        const secrets = environmentSecretStore(
            Object.fromEntries(secretNames.map((name) => [name, environment[name]])),
        );
        return {
            browser: buildAdapters.containerBrowserDriver({ executablePath, proxyServer }),
            secrets,
            redactor: withDeclaredSecretRedaction(defaultRedactor(), secretNames, secrets),
            audit: discardingAudit,
            runLogin: loginInTheCrawlSession,
        };
    },

    benchmarkPorts({ executablePath }: { readonly executablePath: string }): BenchmarkPorts {
        const drivers = new Map([["cdp", buildAdapters.hostBrowserDriver({ executablePath })]]);
        return {
            audit: discardingAudit,
            protectedBranchHolding,
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
