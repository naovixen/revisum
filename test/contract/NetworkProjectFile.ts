// The network-stubs test project, as a person writes it: the stubs, observed requests and storage
// entries the browser tests declare, on the first origin unless a name says otherwise. Every
// declaration that writes may be used in a proposal, since the harness runs proposals.
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import type { JsonRecord } from "#test-support/browser/RawPlan.ts";

const STEP_TIMEOUT_MILLISECONDS = 5000;
// Longer than the 300 ms between the two requests "Load two batches" sends, so a count that waits
// for quiet sees both.
export const QUIET_MILLISECONDS = 800;
// The cap the bigItems request keeps of a body; /api/big-items answers with more.
const BIG_ITEMS_CAP_BYTES = 1024;

// The stub fixture whose JSON text holds script markup.
export const MARKUP_FIXTURE = "script-markup.json";

// Secrets the project declares, for a stub's and a storage entry's secret parameter.
export const STUB_SECRET = "STUB_ACCOUNT_TOKEN";
export const STORAGE_SECRET = "STORAGE_SESSION_TOKEN";

const matcher = (
    origin: string,
    method: string,
    path: string,
    match: "exact" | "prefix" = "exact",
): JsonRecord => ({ origin, method, path, match });
const jsonResponse = (json: unknown, status = 200): JsonRecord => ({
    status,
    mediaType: "application/json",
    body: { json },
});

const stubs = (origin: string): JsonRecord => ({
    // Three answers in order; the last one repeats.
    answerSequence: {
        request: matcher(origin, "GET", "/api/sequence"),
        parameters: {},
        responses: [
            jsonResponse({ answer: 1 }),
            jsonResponse({ answer: 2 }),
            jsonResponse({ answer: 3 }),
        ],
        allowInProposals: true,
    },
    // Data whose text holds script markup, from the project's fixtures folder.
    markupNotes: {
        request: matcher(origin, "GET", "/api/notes"),
        parameters: {},
        responses: [
            { status: 200, mediaType: "application/json", body: { fixture: MARKUP_FIXTURE } },
        ],
        allowInProposals: true,
    },
    // Everything under /api/assets/: only its fetch and XHR requests may get this answer.
    assetRequests: {
        request: matcher(origin, "GET", "/api/assets/", "prefix"),
        parameters: {},
        responses: [jsonResponse({ source: "stub" })],
        allowInProposals: true,
    },
    workerItems: {
        request: matcher(origin, "GET", "/api/worker-items"),
        parameters: {},
        responses: [jsonResponse({ source: "stub", items: [{ name: "Stubbed kettle" }] })],
        allowInProposals: true,
    },
    stubbedData: {
        request: matcher(origin, "GET", "/api/stubbed-data"),
        parameters: {},
        responses: [jsonResponse({ source: "stub" })],
        allowInProposals: true,
    },
    // A token from a declared secret, which the page shows in a private element.
    accountToken: {
        request: matcher(origin, "GET", "/api/token"),
        parameters: { token: { kind: "secret" } },
        responses: [jsonResponse({ token: { $parameter: "token" } })],
        allowInProposals: true,
    },
});

const observedRequests = (origin: string): JsonRecord => ({
    items: {
        request: matcher(origin, "GET", "/api/items"),
        fields: {
            firstName: "/items/0/name",
            itemList: "/items",
            total: "/total",
            nothing: "/nothing",
        },
        maximumResponseBytes: 4096,
    },
    bigItems: {
        request: matcher(origin, "GET", "/api/big-items"),
        fields: { firstName: "/items/0/name" },
        maximumResponseBytes: BIG_ITEMS_CAP_BYTES,
    },
    plainItems: {
        request: matcher(origin, "GET", "/api/plain-items"),
        fields: { firstName: "/items/0/name" },
    },
    missingItems: {
        request: matcher(origin, "GET", "/api/missing-items"),
        fields: { code: "/code" },
    },
    neverSent: {
        request: matcher(origin, "GET", "/api/never"),
        fields: { firstName: "/items/0/name" },
    },
    scheduleLoads: { request: matcher(origin, "GET", "/api/schedule"), fields: { day: "/day" } },
    sequence: { request: matcher(origin, "GET", "/api/sequence") },
    workerItems: {
        request: matcher(origin, "GET", "/api/worker-items"),
        fields: { source: "/source" },
    },
    profile: { request: matcher(origin, "GET", "/api/profile"), fields: { email: "/email" } },
    token: { request: matcher(origin, "GET", "/api/token"), fields: { token: "/token" } },
});

const storageEntries = (origin: string, otherOrigin: string): JsonRecord => ({
    // A boolean parameter, so it is stored as the JSON text "true" or "false".
    menuDocked: {
        area: "local",
        origin,
        key: "navigation.docked",
        access: "readWrite",
        value: { $parameter: "docked" },
        parameters: { docked: { kind: "boolean" } },
        allowInProposals: true,
    },
    // A string, stored as it is.
    visitGreeting: {
        area: "session",
        origin,
        key: "visit.greeting",
        access: "readWrite",
        value: "Welcome back",
        allowInProposals: true,
    },
    // The same key on the other origin.
    otherMenuDocked: {
        area: "local",
        origin: otherOrigin,
        key: "navigation.docked",
        access: "readWrite",
        value: { $parameter: "docked" },
        parameters: { docked: { kind: "boolean" } },
        allowInProposals: true,
    },
    // The name the account page keeps itself; a plan may only check it.
    profileName: {
        area: "local",
        origin,
        key: "profile.name",
        access: "read",
        allowInProposals: false,
    },
    sessionToken: {
        area: "session",
        origin,
        key: "auth.token",
        access: "readWrite",
        value: { $parameter: "token" },
        parameters: { token: { kind: "secret" } },
        allowInProposals: true,
    },
});

// `extraOrigins` are allowed besides the two fixture origins.
export const networkProjectFile = (
    origin: string,
    otherOrigin: string,
    extraOrigins: readonly string[] = [],
) => ({
    origins: [origin, otherOrigin, ...extraOrigins],
    limits: {
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        requestQuietMilliseconds: QUIET_MILLISECONDS,
    },
    secretNames: [STUB_SECRET, STORAGE_SECRET],
    fixtures: [MARKUP_FIXTURE],
    stubs: stubs(origin),
    observedRequests: observedRequests(origin),
    storageEntries: storageEntries(origin, otherOrigin),
    matrix: englishMatrix([BrowserTarget.Chrome]),
});
