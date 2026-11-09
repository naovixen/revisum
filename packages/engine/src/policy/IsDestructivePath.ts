// How the policy gate reads a URL's path: the way servers commonly read it, so no spelling of a
// destructive path slips past.
import type { AllowedUrl } from "@revisum/contracts";
import type { ProjectPolicy } from "../project/ParseProject.ts";

// Only used to read the path of a URL that is relative to the app under test.
const RELATIVE_BASE = new URL("https://relative.invalid");

// How many times a path is decoded before the gate stops trusting what it can read of it. Each
// layer of encoding takes one round, and the last round only confirms nothing changed.
const MAXIMUM_DECODING_ROUNDS = 5;
const RUN_OF_ESCAPES = /(?:%[0-9a-f]{2})+/giu;
const UTF8 = new TextDecoder();

// Each run of valid escapes decoded on its own, so a malformed escape stays as written and stops
// nothing. Bytes that are not UTF-8 become U+FFFD.
const withEscapesDecoded = (path: string): string =>
    path.replace(RUN_OF_ESCAPES, (run) =>
        UTF8.decode(
            Uint8Array.from(run.split("%").slice(1), (escape) => Number.parseInt(escape, 16)),
        ),
    );

// Some servers read a backslash as a slash.
const withBackslashesAsSlashes = (path: string): string => path.replace(/\\/gu, "/");

const decodedOnce = (path: string): string => withBackslashesAsSlashes(withEscapesDecoded(path));

// Some servers also drop white space at the end of a path, so it counts no more than a last slash.
const comparableForm = (decoded: string): string =>
    decoded
        .toLowerCase()
        .replace(/;[^/]*/gu, "")
        .replace(/\/+/gu, "/")
        .replace(/[\s/]+$/u, "");

// The path with its "." and ".." segments resolved, a path parameter on one included, as Tomcat reads
// "..;x=1". Servers differ on whether "//" holds an empty segment that ".." climbs out of.
function withoutDotSegments(path: string, isMergingSlashes: boolean): string {
    const kept: string[] = [];
    for (const segment of path.split("/").slice(1)) {
        const name = segment.replace(/;.*$/u, "");
        if (name === "..") {
            kept.pop();
        } else if (name !== "." && (segment !== "" || !isMergingSlashes)) {
            kept.push(segment);
        }
    }
    return `/${kept.join("/")}`;
}

// A path compared the way servers commonly read it: percent-decoded through every layer,
// case-insensitive, with backslashes as slashes and path parameters, repeated slashes and whatever
// trails in slashes and white space removed, so "/Account//%2564elete;x=1/" still reads as
// /account/delete. A server may decode a path more than
// once and only then resolve what is left, so `resolved` reads it with its dot segments resolved after
// each round. `decoded` reads it without, as a server that decodes once does: resolving alone would
// allow "/account/delete/%252e%252e/settings", which that server reads as under /account/delete.
type ComparablePath = { readonly decoded: string; readonly resolved: readonly string[] };

// Null when the path holds more layers than the gate will read.
function comparablePath(path: string): ComparablePath | null {
    let decoded = withBackslashesAsSlashes(path);
    let keepingSlashes = withoutDotSegments(decoded, false);
    let mergingSlashes = withoutDotSegments(decoded, true);
    for (let round = 0; round < MAXIMUM_DECODING_ROUNDS; round++) {
        const next = decodedOnce(decoded);
        if (next === decoded) {
            return {
                decoded: comparableForm(decoded),
                resolved: [comparableForm(keepingSlashes), comparableForm(mergingSlashes)],
            };
        }
        decoded = next;
        keepingSlashes = withoutDotSegments(decodedOnce(keepingSlashes), false);
        mergingSlashes = withoutDotSegments(decodedOnce(mergingSlashes), true);
    }
    return null;
}

// True when any reading of `path` is a destructive path or continues one after a "/". A path or
// pattern too deeply encoded to read might be one, so it counts as one. A pattern names one route as
// a person wrote it, so only its decoded form counts.
export function isDestructivePath(path: string, policy: ProjectPolicy): boolean {
    const visited = comparablePath(path);
    if (visited === null) {
        return true;
    }
    const readings = [visited.decoded, ...visited.resolved];
    return policy.destructiveUrlPatterns.some((pattern) => {
        const destructive = comparablePath(pattern)?.decoded;
        return (
            destructive === undefined ||
            readings.some(
                (reading) => reading === destructive || reading.startsWith(`${destructive}/`),
            )
        );
    });
}

// A URL as the policy gate reads it. A relative URL has no origin of its own.
export type ReadUrl = { readonly origin: string | null; readonly path: string };

// The URL a plan or a link names, read once. One the plan parser accepted always reads; other text
// may not, and is then null.
export function readUrl(url: AllowedUrl): ReadUrl;
export function readUrl(url: string): ReadUrl | null;
export function readUrl(url: string): ReadUrl | null {
    try {
        const parsed = new URL(url, RELATIVE_BASE);
        return {
            origin: parsed.origin === RELATIVE_BASE.origin ? null : parsed.origin,
            path: parsed.pathname,
        };
    } catch {
        return null;
    }
}
