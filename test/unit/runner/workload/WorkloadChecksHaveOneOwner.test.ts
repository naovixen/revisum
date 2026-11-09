// Two rules the runner's behaviour cannot show on its own, so they are read from its source, as the
// product-name rule is: the path checks of a workload request have one owner, and which services a
// policy relays over TCP is decided in one place. Both read the code's tokens, not its text, so
// comments, quotes and line wrapping do not matter; a removed file passes as having no copy of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../../../support/repository/RepositoryRoot.ts";
import type { Token } from "../../../../tools/repo-rules/naming/LintRepository.ts";
import { codeTokens, listSourceFiles } from "../../../../tools/repo-rules/ListSourceFiles.ts";
import { TokenKind } from "../../../../tools/repo-rules/naming/LintRepository.ts";

const RUNNER_SOURCE = "packages/runner/src";
const THE_ONE_SELECTION = `${RUNNER_SOURCE}/egress-proxy/tunnels/TcpRelay.ts`;
const POLICY_BUILDER = `${RUNNER_SOURCE}/egress/BuildEgressPolicy.ts`;
const REMOVE_FROM_OUTPUT = `${RUNNER_SOURCE}/workload/output/RemoveFromOutput.ts`;

type Source = { readonly path: string; readonly tokens: readonly Token[] };

const runnerSources = (): readonly Source[] =>
    listSourceFiles(REPOSITORY_ROOT, [RUNNER_SOURCE]).map((path) => ({
        path,
        tokens: codeTokens(readFileSync(join(REPOSITORY_ROOT, path), "utf8")),
    }));

const usesIdentifier = (tokens: readonly Token[], name: string): boolean =>
    tokens.some((token) => token.kind === TokenKind.Identifier && token.text === name);

describe("Using the runner's sources", () => {
    describe("given the removal from an output folder", () => {
        describe("when its code is read", () => {
            test("then it should hold no path check of its own beside the request's parser", () => {
                const sources = runnerSources().filter(
                    (source) => source.path === REMOVE_FROM_OUTPUT,
                );
                const ownChecks = sources.flatMap((source) =>
                    ["isSafeInMountArgument", "isAbsolute"].filter((name) =>
                        usesIdentifier(source.tokens, name),
                    ),
                );
                assert.deepEqual(ownChecks, []);
            });
        });
    });

    describe("given the services a policy relays over TCP", () => {
        describe("when the runner's code is read", () => {
            test("then it should choose them only in the one selection", () => {
                const others = runnerSources()
                    .filter((source) => usesIdentifier(source.tokens, "allowTcpServices"))
                    .map((source) => source.path)
                    .filter((path) => path !== THE_ONE_SELECTION && path !== POLICY_BUILDER);
                assert.deepEqual(others, []);
            });
        });
    });
});
