// What a run's manifest pins about the machine and the repository it starts on, which the engine
// cannot see for itself: the versions of Revisum, the ACT rule set, axe-core, Node and the installed
// packs; hashes of the PII redactor, the rule set, the baselines the plan reads and the system
// fonts; the run image's id; and the repository's commit. The run command passes them to every
// run as RunInputs.pins.
import { ACT_RULESET_VERSION, ALL_RULES, SCAN_VIEWPORT } from "@revisum/auditor-act";
import { AXE_VERSION } from "@revisum/auditor-axe";
import {
    DEFAULT_PII_PATTERNS,
    DEFAULT_PII_SELECTORS,
    canonicalJson,
    sha256,
    type RunPins,
} from "@revisum/engine";
import { RUN_IMAGE_RECORD, readImageDigest } from "@revisum/runner";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// A baseline file the plan reads, by its repository-relative path and content.
export type BaselineFile = { readonly path: string; readonly bytes: Uint8Array };

export type RunPinsOptions = {
    readonly repositoryRoot: string;
    // The baselines the plan reads; none while the plan language reads none.
    readonly baselines?: readonly BaselineFile[];
    // The extra mask selectors the project adds to the default ones, if any.
    readonly maskSelectors?: readonly string[];
};

// Revisum's own version: the cli package's.
function coreVersion(): string {
    const manifest: unknown = JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    );
    const version: unknown =
        typeof manifest === "object" && manifest !== null
            ? Reflect.get(manifest, "version")
            : undefined;
    return typeof version === "string" ? version : "unknown";
}

// The PII patterns and mask selectors, hashed: the secrets themselves are recorded by name apart.
function redactorHash(maskSelectors: readonly string[]): string {
    return sha256(
        canonicalJson({
            patterns: DEFAULT_PII_PATTERNS.map((rule) => ({
                label: rule.label,
                source: rule.pattern.source,
                flags: rule.pattern.flags,
            })),
            selectors: [...DEFAULT_PII_SELECTORS, ...maskSelectors],
        }),
    );
}

// The own accessibility engine's rule ids and how it probes a page.
const rulesetHash = (): string =>
    sha256(
        canonicalJson({
            rules: ALL_RULES.map((rule) => rule.meta.id).sort(),
            probes: { viewport: SCAN_VIEWPORT },
        }),
    );

const byPath = (left: { readonly path: string }, right: { readonly path: string }): number => {
    if (left.path === right.path) {
        return 0;
    }
    return left.path < right.path ? -1 : 1;
};

const baselinesHash = (baselines: readonly BaselineFile[]): string =>
    sha256(
        canonicalJson(
            [...baselines]
                .map((file) => ({ path: file.path, sha256: sha256(file.bytes) }))
                .toSorted(byPath),
        ),
    );

// The run image's id, as runner's prepareRunImage recorded it beside the repository; undefined on
// a machine that never prepared one, where the run is a host run.
function runImageDigest(repositoryRoot: string): string | undefined {
    const path = join(repositoryRoot, RUN_IMAGE_RECORD);
    if (!existsSync(path)) {
        return undefined;
    }
    try {
        const record: unknown = JSON.parse(readFileSync(path, "utf8"));
        const id: unknown =
            typeof record === "object" && record !== null ? Reflect.get(record, "id") : undefined;
        return typeof id === "string" ? (readImageDigest(id) ?? undefined) : undefined;
    } catch {
        return undefined;
    }
}

function commitOf(repositoryRoot: string): string | null {
    const ran = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 10_000,
    });
    const commit = ran.status === 0 ? ran.stdout.trim() : "";
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
}

// Where each operating system keeps its fonts.
function fontFolders(): string[] {
    switch (platform()) {
        case "win32":
            return [join(process.env["SystemRoot"] ?? "C:\\Windows", "Fonts")];
        case "darwin":
            return ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library", "Fonts")];
        default:
            return [
                "/usr/share/fonts",
                "/usr/local/share/fonts",
                join(homedir(), ".fonts"),
                join(homedir(), ".local", "share", "fonts"),
            ];
    }
}

function filesUnder(folder: string): string[] {
    if (!existsSync(folder)) {
        return [];
    }
    try {
        return readdirSync(folder, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name));
    } catch {
        return [];
    }
}

async function fileSha256(path: string): Promise<string | null> {
    try {
        const hash = createHash("sha256");
        const chunks: AsyncIterable<Buffer> = createReadStream(path);
        for await (const chunk of chunks) {
            hash.update(chunk);
        }
        return hash.digest("hex");
    } catch {
        return null;
    }
}

// Every system font file's path and content hash, sorted, hashed. Fonts decide how text renders in
// a screenshot. Read once per process: they do not change while a command runs.
let fontsHash: Promise<string> | undefined;
function systemFontsHash(): Promise<string> {
    fontsHash ??= (async () => {
        const files = fontFolders().flatMap(filesUnder).sort();
        const entries: { readonly path: string; readonly sha256: string | null }[] = [];
        for (const path of files) {
            entries.push({ path, sha256: await fileSha256(path) });
        }
        return sha256(canonicalJson(entries));
    })();
    return fontsHash;
}

export async function runPins(options: RunPinsOptions): Promise<RunPins> {
    const imageDigest = runImageDigest(options.repositoryRoot);
    return {
        // Packs are not built yet; until then none is installed.
        versions: {
            core: coreVersion(),
            act: ACT_RULESET_VERSION,
            axe: AXE_VERSION,
            node: process.version,
            packs: [],
        },
        redactor: redactorHash(options.maskSelectors ?? []),
        rulesetHash: rulesetHash(),
        baselinesHash: baselinesHash(options.baselines ?? []),
        ...(imageDigest === undefined ? {} : { imageDigest }),
        fontsSha256: await systemFontsHash(),
        commit: commitOf(options.repositoryRoot),
    };
}
