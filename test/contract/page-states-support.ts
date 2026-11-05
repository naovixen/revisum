// Shared setup for the browser tests of the plan language's page checks, downloads and second
// tab: accessibility states, link targets, head metadata, pages loaded with scripts off, the
// download step and its checks, and newTab blocks.
//
// It serves the page-states fixture app (fixtures/page-states-app/) and, beside its files, routes
// the tests build: files to download under /exports/ (a CSV, an empty CSV, a CSV larger than the
// project's download limit streamed with no Content-Length, a PNG, and files whose server-sent
// names are hostile), /sign-in, which sets an HttpOnly session cookie, and /account, which shows
// whether the browser sent that cookie. Every file to download holds a marker made fresh for the
// harness, so a test can search the disk for any copy of it.
//
// The project's target is the own CDP driver on Chrome for Testing, with a 64 KiB download limit.
// Every run reads the page just before the run closes its session, after an optional test hook.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneElementOf, type Session } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
import { rawPlan, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import type { FixtureResponse, FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";

const SEED = 31;
// The run's own clock start: 30 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 30, 12, 0, 0);
const STEP_TIMEOUT_MILLISECONDS = 2000;
export const MAXIMUM_DOWNLOAD_BYTES = 64 * 1024;

const FIXTURE_FOLDER = join(FIXTURES, "page-states-app");

// `keepDownloads` adds an evidence section.
const pageStatesProjectFile = (origin: string, keepDownloads?: boolean) => ({
    origins: [origin],
    limits: {
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        maximumDownloadBytes: MAXIMUM_DOWNLOAD_BYTES,
    },
    ...(keepDownloads === undefined ? {} : { evidence: { keepDownloads } }),
    matrix: englishMatrix([BrowserTarget.Chrome]),
});

export const navigateWithoutScripts = (url: unknown): JsonRecord => ({
    type: "navigate",
    url,
    scripts: "disabled",
});
export const expectState = (
    locator: JsonRecord,
    kind: string,
    criterionId: string,
): JsonRecord => ({ type: "expect", locator, assert: { kind }, criterionId });
export const hrefEquals = (
    locator: JsonRecord,
    value: unknown,
    criterionId: string,
): JsonRecord => ({ type: "expect", locator, assert: { kind: "hrefEquals", value }, criterionId });
export const metaContent = (name: string, value: unknown, criterionId: string): JsonRecord => ({
    type: "expectPage",
    assert: { kind: "metaContent", name, value },
    criterionId,
});
export const canonicalUrl = (value: string, criterionId: string): JsonRecord => ({
    type: "expectPage",
    assert: { kind: "canonicalUrl", value },
    criterionId,
});
export const download = (name: string, locator: JsonRecord): JsonRecord => ({
    type: "download",
    name,
    locator,
});
export const expectDownload = (
    name: string,
    assertion: JsonRecord,
    criterionId: string,
): JsonRecord => ({ type: "expectDownload", download: name, assert: assertion, criterionId });

export const pagePlan = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        {
            featureId: "STATES-1",
            specReference: "specs/page-states.md#driver",
            title: "Page states, downloads and tabs in a browser",
        },
        targetId,
        steps,
        fields,
    );

// A file a route serves as a download: where it is, the name and media type the server sends,
// its bytes and the marker text they hold.
export type ServedFile = {
    readonly path: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly bytes: Buffer;
    readonly marker: string;
};

// A file whose server-sent name is hostile, and the link on downloads.html that fetches it.
export type HostileFile = ServedFile & { readonly linkName: string; readonly kind: string };

type ExportFiles = {
    readonly projects: ServedFile;
    readonly empty: ServedFile;
    readonly invoices: ServedFile;
    readonly logo: ServedFile;
    readonly contacts: ServedFile;
    // Larger than MAXIMUM_DOWNLOAD_BYTES; every line of it holds the marker.
    readonly oversize: ServedFile;
};

const attachment = (fileName: string): string => `attachment; filename="${fileName}"`;
// A name sent in RFC 6266's extended form, so it reaches the browser exactly as written.
const extendedAttachment = (fileName: string): string =>
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;

const served = (
    path: string,
    fileName: string,
    mediaType: string,
    text: string,
    marker: string,
): ServedFile => ({ path, fileName, mediaType, bytes: Buffer.from(text, "utf8"), marker });

// A real PNG signature and header chunk, then the marker inside a text chunk: bytes that are not
// UTF-8 text (0x89, 0xFF and zero bytes), though "PNG" and the marker are readable in them.
const logoBytesWith = (marker: string): Buffer =>
    Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from([
            0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15,
            0xc4, 0x89,
        ]),
        Buffer.from(`tEXt${marker}`, "latin1"),
        Buffer.from([0xff, 0xfe, 0x00, 0x00, 0xff]),
    ]);

function exportFiles(nonce: string, contactsText: string | undefined): ExportFiles {
    const projectsMarker = `projects-export-${nonce}`;
    const invoicesMarker = `invoices-export-${nonce}`;
    const logoMarker = `logo-export-${nonce}`;
    const contactsMarker = `contacts-export-${nonce}`;
    const oversizeMarker = `oversize-history-${nonce}`;
    const oversizeLine = `${oversizeMarker},Archived row,0000\n`;
    const oversizeText = oversizeLine.repeat(
        Math.ceil((4 * MAXIMUM_DOWNLOAD_BYTES) / oversizeLine.length),
    );
    return {
        projects: served(
            "/exports/projects.csv",
            "projects.csv",
            "text/csv",
            `Project,Owner,Status\nWebsite relaunch,Priya,Active\nMobile app,Tomas,Planned\nReference,${projectsMarker},\n`,
            projectsMarker,
        ),
        empty: served("/exports/empty.csv", "empty.csv", "text/csv", "", ""),
        invoices: served(
            "/exports/invoices.csv",
            "invoices.csv",
            "text/csv",
            `Invoice,Total\nINV-1,120\nReference,${invoicesMarker}\n`,
            invoicesMarker,
        ),
        logo: {
            path: "/exports/logo.png",
            fileName: "logo.png",
            mediaType: "image/png",
            bytes: logoBytesWith(logoMarker),
            marker: logoMarker,
        },
        contacts: served(
            "/exports/contacts.csv",
            "contacts.csv",
            "text/csv",
            contactsText ?? `Contact,Team\nReception,Front desk\nReference,${contactsMarker}\n`,
            contactsMarker,
        ),
        oversize: served(
            "/exports/oversize.csv",
            "oversize.csv",
            "text/csv",
            oversizeText,
            oversizeMarker,
        ),
    };
}

function hostileFiles(nonce: string): readonly HostileFile[] {
    const hostile = (kind: string, linkName: string, fileName: string): HostileFile => {
        const marker = `hostile-download-${nonce}-${kind}`;
        return {
            kind,
            linkName,
            fileName,
            path: `/exports/hostile/${kind}`,
            mediaType: "text/plain",
            bytes: Buffer.from(`${marker}\nA file with a hostile name.\n`, "utf8"),
            marker,
        };
    };
    return [
        hostile("parent-path", "Export parent path", "../../etc/passwd"),
        // The same shape with a name only this harness uses, so a search of the disk can find it.
        hostile("parent-escape", "Export escaping name", `../../revisum-escaped-${nonce}.txt`),
        hostile(
            "absolute-path",
            "Export absolute path",
            join(tmpdir(), `revisum-escaped-${nonce}-absolute.txt`),
        ),
        hostile("device-con", "Export device name", "CON"),
        hostile("device-nul", "Export null device name", "NUL.txt"),
    ];
}

// The session cookie /sign-in sets, and what /account shows for it.
export const SESSION_COOKIE = "session=signed-in-ada";

function routesFor(
    files: ExportFiles,
    hostile: readonly HostileFile[],
): ReadonlyMap<string, FixtureRoute> {
    const routes = new Map<string, FixtureRoute>();
    const downloadRoute =
        (file: ServedFile, disposition: string): FixtureRoute =>
        (): FixtureResponse => ({
            headers: { "content-type": file.mediaType, "content-disposition": disposition },
            body: file.bytes,
        });
    for (const file of [files.projects, files.empty, files.invoices, files.logo, files.contacts]) {
        routes.set(file.path, downloadRoute(file, attachment(file.fileName)));
    }
    // Sent in 16 KiB pieces with no Content-Length, so the size is known only as the bytes arrive.
    const pieceSize = 16 * 1024;
    const pieces: Buffer[] = [];
    for (let start = 0; start < files.oversize.bytes.length; start += pieceSize) {
        pieces.push(files.oversize.bytes.subarray(start, start + pieceSize));
    }
    routes.set(files.oversize.path, () => ({
        headers: {
            "content-type": files.oversize.mediaType,
            "content-disposition": attachment(files.oversize.fileName),
        },
        chunks: pieces,
        chunkPauseMilliseconds: 20,
    }));
    for (const file of hostile) {
        routes.set(file.path, downloadRoute(file, extendedAttachment(file.fileName)));
    }
    routes.set("/sign-in", () => ({
        status: 302,
        headers: {
            location: "/signed-in.html",
            "set-cookie": `${SESSION_COOKIE}; HttpOnly; Path=/; SameSite=Lax`,
        },
    }));
    const accountTemplate = readFileSync(join(FIXTURE_FOLDER, "account.html"), "utf8");
    routes.set("/account", (request) => {
        const isSignedIn = request.cookie
            .split(";")
            .map((part) => part.trim())
            .includes(SESSION_COOKIE);
        return {
            headers: { "content-type": "text/html; charset=utf-8" },
            body: accountTemplate.replace("SESSION_STATE", isSignedIn ? "Signed in" : "Signed out"),
        };
    });
    return routes;
}

type PageStatesHarnessOptions = {
    // Sets the project's evidence.keepDownloads; absent leaves the project without an evidence section.
    readonly keepDownloads?: boolean;
    // The text /exports/contacts.csv serves, in place of a harmless default.
    readonly contactsText?: string;
};

export type PageStatesHarness = BrowserHarness & {
    // Fresh for this harness: part of every marker and escaping name it serves.
    readonly nonce: string;
    readonly files: ExportFiles;
    readonly hostileFiles: readonly HostileFile[];
};

export async function pageStatesHarness(
    options: PageStatesHarnessOptions = {},
): Promise<PageStatesHarness> {
    const nonce = randomBytes(6).toString("hex");
    const files = exportFiles(nonce, options.contactsText);
    const hostile = hostileFiles(nonce);
    const harness = await startBrowserHarness({
        fixtureFolder: FIXTURE_FOLDER,
        routes: routesFor(files, hostile),
        projectFile: (origin) => pageStatesProjectFile(origin, options.keepDownloads),
        seed: SEED,
        fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
        drivers: driversForTargets([BrowserTarget.Chrome]),
        planFor: pagePlan,
        readAtClose: ["input-events"],
    });
    return { ...harness, nonce, files, hostileFiles: hostile };
}

// Waits until the probe of a test id shows text other than `pending`, for up to `limit`
// milliseconds, and gives the last text seen.
export async function settledText(
    harness: PageStatesHarness,
    session: Session,
    id: string,
    pending: string,
    limit = 3000,
): Promise<string> {
    const deadline = Date.now() + limit;
    let shown = pending;
    while (Date.now() < deadline) {
        const probed = await session.probe(harness.locator(testId(id)), null);
        const found = oneElementOf(probed);
        shown = found.ok ? found.value.text : "(not one element)";
        if (shown !== pending) {
            return shown;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return shown;
}
