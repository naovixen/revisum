import { failure, success, type VersionControlPort } from "@revisum/engine";
import { leaveOut, type OptionalMember } from "./LeaveOut.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A protected branch that holds only `project` as project.json, as loading a trusted project reads
// it, on a port that only loads one.
export const fakeProtectedBranchHolding = (project: unknown): Recorded<VersionControlPort> =>
    fakeVersionControlPort(
        {
            protectedFile: (path) =>
                Promise.resolve(
                    path === "project.json"
                        ? success({
                              bytes: new TextEncoder().encode(JSON.stringify(project)),
                              commit: "commit-protected",
                          })
                        : failure("not-found"),
                ),
        },
        ["fileAtCommit"],
    );

// A repository with no files and a host that answers nothing about pull requests, so no approval
// can rest on it. An approval that needs an unavailable answer is absent, never assumed.
export function fakeVersionControlPort(
    overrides: Partial<VersionControlPort> = {},
    without: readonly OptionalMember<VersionControlPort>[] = [],
): Recorded<VersionControlPort> {
    const defaults: Required<VersionControlPort> = {
        protectedBranch: "main",
        protectedFile: () => Promise.resolve(failure("not-found")),
        reviews: () => Promise.resolve(failure("unavailable")),
        changedFiles: () => Promise.resolve(failure("unavailable")),
        pullRequest: () => Promise.resolve(failure("unavailable")),
        lastCommitTouching: () => Promise.resolve(failure("unavailable")),
        fileAtCommit: () => Promise.resolve(failure("not-found")),
        landedBy: () => Promise.resolve(failure("unavailable")),
    };
    return recordCalls(leaveOut<VersionControlPort>({ ...defaults, ...overrides }, without));
}
