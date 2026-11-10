// What tests ask of a browser that the driver has no reason to ask, each with the decoder of its reply,
// as the driver's own commands have. They are built here since the driver exports only what its callers
// send. A reply of another shape fails the test that asked.
import assert from "node:assert/strict";
import { EVALUATE } from "@revisum/driver-cdp";
import { success, type Result } from "@revisum/engine";

export type TestCommand<CommandParameters, Reply> = {
    readonly method: string;
    // Only the compiler reads this: it ties what a command takes to the command.
    readonly parameters?: CommandParameters;
    decode(reply: unknown): Reply;
};

type NoParameters = Readonly<Record<string, never>>;

const testCommand =
    <CommandParameters>() =>
    <Reply>(
        method: string,
        decode: (reply: unknown) => Reply,
    ): TestCommand<CommandParameters, Reply> => ({ method, decode });

const nothingToRead = (): void => undefined;

function listIn(reply: unknown, field: string): readonly unknown[] {
    assert.ok(typeof reply === "object" && reply !== null, `${field}: the reply is no object`);
    const list: unknown = Reflect.get(reply, field);
    assert.ok(Array.isArray(list), `${field}: the reply holds no list`);
    return list;
}

function textIn(value: unknown, field: string): string {
    const text: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;
    assert.ok(typeof text === "string", `${field}: the reply holds no text`);
    return text;
}

export const CLOSE_THE_BROWSER = testCommand<NoParameters>()("Browser.close", nothingToRead);

export const GRANT_PERMISSIONS = testCommand<{
    readonly origin: string;
    readonly permissions: readonly string[];
}>()("Browser.grantPermissions", nothingToRead);

export const CREATE_A_CONTEXT = testCommand<{ readonly disposeOnDetach: boolean }>()(
    "Target.createBrowserContext",
    nothingToRead,
);

// The ids of the browser contexts still in the browser.
export const LIST_CONTEXTS = testCommand<NoParameters>()(
    "Target.getBrowserContexts",
    (reply): readonly string[] =>
        listIn(reply, "browserContextIds").map((id) => {
            assert.ok(typeof id === "string", "a browser context's id is no text");
            return id;
        }),
);

// The addresses of the targets of a type.
export const LIST_TARGET_URLS = testCommand<{
    readonly filter: readonly { readonly type: string }[];
}>()("Target.getTargets", (reply): readonly string[] =>
    listIn(reply, "targetInfos").map((info) => textIn(info, "url")),
);

export const NO_SUCH_COMMAND = testCommand<NoParameters>()("No.suchMethod", nothingToRead);

// An expression run as if a person's gesture had started it, which is what lets a page read the clipboard.
export const EVALUATE_WITH_A_GESTURE = testCommand<{
    readonly expression: string;
    readonly awaitPromise: boolean;
    readonly returnByValue: boolean;
    readonly userGesture: boolean;
}>()(EVALUATE.method, (reply) => EVALUATE.decode(reply));

export const PAGE_LOADED = {
    name: "Page.loadEventFired",
    decode: (): Result<void, string> => success(undefined),
};
