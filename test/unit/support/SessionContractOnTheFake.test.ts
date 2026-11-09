// The fake session against the behaviour the real driver is held to in test/contract, so a run on the
// fake ends as a run on a driver would.
import { describe } from "node:test";
import { fakeSession } from "#test-support/fakes/session/FakeSession.ts";
import { sessionContract } from "#test-support/session-contract/SessionContract.ts";

describe("Using a fake session as a driver's session", () => {
    sessionContract(() => {
        const session = fakeSession();
        return Promise.resolve({
            session,
            pageUrl: "https://app.example/other",
            openDialog: (text) => {
                session.openDialog(text);
                return Promise.resolve();
            },
        });
    });
});
