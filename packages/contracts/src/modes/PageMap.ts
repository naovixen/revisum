// Explore mode of the draft command: a deterministic crawl of the running app, with no AI, that
// gives a bounded, redacted page map; the page map is the only page content a planner ever sees.
// The crawl only navigates and reads: it never clicks, types, selects, submits or runs a script of
// its own. These are the types the engine, the CDP driver and the command agree on.
import type { DocumentSession } from "../ports/BrowserDriver.ts";
import type { Origin } from "../ports/Target.ts";
import type { GuaranteeLevel } from "../run-result/GuaranteeLevel.ts";

// How far one crawl may go. `start` is an absolute URL on a declared, non-production origin.
export type ExploreOptions = {
    readonly start: string;
    // Pages kept in the map, from 1 to 100; 20 unless the person asks for another number.
    readonly maximumPages: number;
    // Links followed from the start page, from 0 to 5; 3 unless asked otherwise.
    readonly maximumDepth: number;
    // How long one page may take to load before it is left out.
    readonly pageTimeoutMilliseconds: number;
    // Where the browser ran: inside the isolated runner, or on the host with no egress enforcement.
    readonly placement: GuaranteeLevel;
};

// One node of a page's outline: an accessible role and its name, never a value or text content.
export type PageMapNode = {
    readonly role: string;
    readonly name: string;
    readonly children: readonly PageMapNode[];
};
// One crawled page: its URL path (no query or fragment), title, link depth from the start page and outline.
export type PageMapEntry = {
    readonly path: string;
    readonly title: string;
    readonly depth: number;
    readonly tree: readonly PageMapNode[];
};
export type PageMap = {
    readonly origin: Origin;
    // In crawl order: breadth first from the start page, each page's new links in sorted order.
    readonly pages: readonly PageMapEntry[];
    // True when a page on the start origin was left unvisited because of maximumPages or maximumDepth,
    // or was left out because it loaded and then could not be read, such as with a dialog holding it.
    readonly truncated: boolean;
    readonly guaranteeLevel: GuaranteeLevel;
};

// Why explore mode stopped before writing a draft. Each is also a command-line error code.
// explore-origin-refused: the start URL is not on a declared origin, or is on a production one.
// after-plan-unapproved: --after names a plan with no approval for its hash.
// explore-runner-unavailable: there is no isolated runner, it did not start, or it could not
// enforce egress, and --host was not given.
// explore-start-unreachable: the start page did not load.
// planner-endpoint-not-loopback: the draft command's local planner endpoint is off the loopback interface.
// planner-call-failed: a planner call failed on the network, at the egress proxy or with the planner's status.
export const ExploreErrorCode = {
    ExploreOriginRefused: "explore-origin-refused",
    AfterPlanUnapproved: "after-plan-unapproved",
    ExploreRunnerUnavailable: "explore-runner-unavailable",
    ExploreStartUnreachable: "explore-start-unreachable",
    PlannerEndpointNotLoopback: "planner-endpoint-not-loopback",
    PlannerCallFailed: "planner-call-failed",
} as const;
export type ExploreErrorCode = (typeof ExploreErrorCode)[keyof typeof ExploreErrorCode];
// The two a crawl itself can stop with.
export type CrawlErrorCode = Extract<
    ExploreErrorCode,
    typeof ExploreErrorCode.ExploreOriginRefused | typeof ExploreErrorCode.ExploreStartUnreachable
>;

// What a crawl may ask of a browser session: navigation and reads, nothing that acts on the page.
export type ExploreDriver = Pick<
    DocumentSession,
    "navigate" | "page" | "accessibilitySnapshot" | "linkTargets"
>;

// A step of an explore draft whose locator does not match its page in the map: no element at all,
// or more than one. A warning, never an error: the draft is still written and admitted.
export const DraftWarningCode = {
    LocatorNotOnPage: "locator-not-on-page",
    LocatorAmbiguous: "locator-ambiguous",
} as const;
export type DraftWarningCode = (typeof DraftWarningCode)[keyof typeof DraftWarningCode];
export type DraftWarning = {
    readonly code: DraftWarningCode;
    // Where the step is in the written draft, the command's notice counted.
    readonly position: { readonly line: number; readonly column: number };
};
