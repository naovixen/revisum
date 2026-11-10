// Reads a GitHub code-owners file and answers who owns a path. Each line is a pattern followed by
// owners; the last line whose pattern matches the path wins, as on GitHub, and a matching line
// with no owners leaves the path unowned. Patterns follow the gitignore rules GitHub uses: a
// leading "/" anchors at the repository root, a trailing "/" matches everything in a folder, "*"
// matches within one path segment and "**" across segments.

export type CodeOwnerRule = { readonly pattern: RegExp; readonly owners: readonly string[] };

const LAST_SEGMENT_ONLY_A_STAR = /(?:^|\/)\*$/;

// A folder pattern matches what is inside the folder, and a file pattern also matches a folder's
// contents. An anchored last segment that is nothing but a star stops there: GitHub reads "docs/*" as
// direct children only, though gitignore would also reach inside any folder the star matched. A last
// segment only partly a star, as in "src/foo*" or "foo*", can name a folder, so it covers what is
// inside that folder.
function patternEnd(body: string, isFolder: boolean, isAnchored: boolean): string {
    if (isFolder) {
        return "/.*$";
    }
    return isAnchored && LAST_SEGMENT_ONLY_A_STAR.test(body) ? "$" : "(?:/.*)?$";
}

// Converts one gitignore-style pattern into a regular expression over a repository path.
function patternExpression(pattern: string): RegExp {
    const folder = pattern.endsWith("/");
    let body = folder ? pattern.slice(0, -1) : pattern;
    // A pattern with a slash anywhere but the end is anchored; one without matches at any depth.
    const anchored = body.includes("/");
    body = body.replace(/^\//, "");
    let expression = "";
    for (let index = 0; index < body.length; index++) {
        const character = body[index] ?? "";
        if (body.startsWith("**/", index)) {
            expression += "(?:.*/)?";
            index += 2;
        } else if (body.startsWith("**", index)) {
            expression += ".*";
            index += 1;
        } else if (character === "*") {
            expression += "[^/]*";
        } else if (character === "?") {
            expression += "[^/]";
        } else {
            expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    const start = anchored ? "^" : "^(?:.*/)?";
    return new RegExp(`${start}${expression}${patternEnd(body, folder, anchored)}`);
}

export function parseCodeOwners(text: string): readonly CodeOwnerRule[] {
    const rules: CodeOwnerRule[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
        if (line === "") {
            continue;
        }
        const [pattern, ...owners] = line.split(/\s+/);
        if (pattern === undefined) {
            continue;
        }
        rules.push({ pattern: patternExpression(pattern), owners });
    }
    return rules;
}

// The owners the last matching rule names for `path`, lowercased; empty when no rule matches.
function ownersOf(rules: readonly CodeOwnerRule[], path: string): readonly string[] {
    const match = rules.findLast((rule) => rule.pattern.test(path));
    return match === undefined ? [] : match.owners.map((owner) => owner.toLowerCase());
}

// True when the code-owners rules name `login` (as "@login") for `path`. Logins compare
// case-insensitively, as on GitHub. Team owners ("@org/team") are not expanded, so a team never
// stands in for a person.
export const isCodeOwner = (
    rules: readonly CodeOwnerRule[],
    path: string,
    login: string,
): boolean => ownersOf(rules, path).includes(`@${login.toLowerCase()}`);
