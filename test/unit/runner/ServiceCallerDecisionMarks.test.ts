// The service caller reads the proxy's mark on one of its own answers once, in one place. A blocked
// mark is a refusal and an unreachable mark is a failure to reach the service. A mark it doesn't know
// is still the proxy's own answer, so it is stated as a refusal: never success, and never by accident
// the "no answer" a retrying call would wait out.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EGRESS_DECISION_HEADER, serviceCaller } from "@revisum/runner";
import { serviceRequest } from "./local-service.ts";

const MARKS_AND_OUTCOMES = [
    { mark: "blocked", title: "a blocked mark", code: "egress-blocked" },
    { mark: "unreachable", title: "an unreachable mark", code: "service-unreachable" },
    { mark: "surprise", title: "a mark it does not know", code: "egress-blocked" },
    { mark: "", title: "an empty mark", code: "egress-blocked" },
] as const;

describe("Using the service caller", () => {
    for (const { mark, title, code } of MARKS_AND_OUTCOMES) {
        describe(`given a proxy that answers with ${title}`, () => {
            let proxy: Server;
            let proxyUrl: string;

            beforeEach(async () => {
                proxy = createServer((incoming, response) => {
                    response.writeHead(403, { [EGRESS_DECISION_HEADER]: mark }).end();
                });
                await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
                proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
            });
            afterEach(async () => {
                await new Promise<void>((resolve) => {
                    proxy.closeAllConnections();
                    proxy.close(() => resolve());
                });
            });

            describe("when a call goes through it", () => {
                test(`then it should fail with ${code}`, async () => {
                    const outcome = await serviceCaller({ proxy: { url: proxyUrl } }).call(
                        serviceRequest("http://service.test"),
                    );
                    assert.deepEqual(outcome, { ok: false, error: code });
                });
            });
        });
    }
});
