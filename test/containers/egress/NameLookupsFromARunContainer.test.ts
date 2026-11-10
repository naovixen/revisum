// A name lookup is a way out as well as a connection: a lookup of a name made up from a run's data
// carries that data to whoever answers for the domain. The run container's network has no route out,
// but Docker's own resolver sits on it, and that resolver could forward what it cannot answer. So a
// lookup of an outside name from a run container must not resolve, by the system's resolver, by a
// DNS query through the container's configured name server, or by asking a public name server
// directly. The same lookup of the run's proxy, on the container's own network, is the
// counter-example that shows lookups work.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createCleanUpScope } from "../../support/CleanUpScope.ts";
import { jsonInside, startIsolatedRun, type IsolatedRun } from "../support/IsolatedRun.ts";

const TIMEOUT = 300_000;
const OUTSIDE_NAME = "example.com";
const PUBLIC_NAME_SERVER = "8.8.8.8";
const LOOKUP_GIVES_UP_MILLISECONDS = 15_000;

type LookupFinding = { readonly resolved: boolean; readonly detail: string };

// Prints whether the callback-style lookup found an address, giving up after a while.
const reportedLookup = (lookup: string): string => `
  const dns = require('node:dns');
  const report = (finding) => { console.log(JSON.stringify(finding)); process.exit(0); };
  setTimeout(() => report({ resolved: false, detail: 'gave up waiting' }), ${LOOKUP_GIVES_UP_MILLISECONDS});
  const done = (error, addresses) => report(error
    ? { resolved: false, detail: String(error.code) }
    : { resolved: true, detail: JSON.stringify(addresses) });
  ${lookup}`;

const systemLookup = (name: string): string =>
    reportedLookup(`dns.lookup(${JSON.stringify(name)}, { all: true }, done);`);

const configuredServerQuery = (name: string): string =>
    reportedLookup(
        `new dns.Resolver({ timeout: 4000, tries: 1 }).resolve4(${JSON.stringify(name)}, done);`,
    );

const publicServerQuery = (name: string): string =>
    reportedLookup(`
      const resolver = new dns.Resolver({ timeout: 4000, tries: 1 });
      resolver.setServers([${JSON.stringify(PUBLIC_NAME_SERVER)}]);
      resolver.resolve4(${JSON.stringify(name)}, done);`);

describe("Using a run container on real Docker", () => {
    describe("given an isolated run on its network with no route out", () => {
        const cleanUps = createCleanUpScope();
        let run: IsolatedRun;
        const findingOf = async (script: string) =>
            (await jsonInside(run.handle, script)) as LookupFinding;

        before(
            async () => {
                run = await startIsolatedRun();
                cleanUps.add(() => run.stop());
                assert.equal(run.handle.guaranteeLevel(), "isolated");
            },
            { timeout: TIMEOUT },
        );

        after(() => cleanUps.runAll(), { timeout: TIMEOUT });

        describe("when an outside name is looked up through the system's resolver", () => {
            test("then it should not resolve", { timeout: TIMEOUT }, async () => {
                const finding = await findingOf(systemLookup(OUTSIDE_NAME));
                assert.equal(finding.resolved, false, finding.detail);
            });
        });

        describe("when an outside name is queried through the configured name server", () => {
            test("then it should not resolve", { timeout: TIMEOUT }, async () => {
                const finding = await findingOf(configuredServerQuery(OUTSIDE_NAME));
                assert.equal(finding.resolved, false, finding.detail);
            });
        });

        describe("when an outside name is queried directly at a public name server", () => {
            test("then it should not resolve", { timeout: TIMEOUT }, async () => {
                const finding = await findingOf(publicServerQuery(OUTSIDE_NAME));
                assert.equal(finding.resolved, false, finding.detail);
            });
        });

        describe("when the name of the run's proxy is looked up", () => {
            test(
                "then it should resolve, so the lookups above were really tried",
                { timeout: TIMEOUT },
                async () => {
                    const proxyAddress = await jsonInside(
                        run.handle,
                        'console.log(JSON.stringify(process.env.HTTP_PROXY ?? ""))',
                    );
                    assert.ok(typeof proxyAddress === "string" && proxyAddress !== "");
                    const finding = await findingOf(systemLookup(new URL(proxyAddress).hostname));
                    assert.equal(finding.resolved, true, finding.detail);
                },
            );
        });
    });
});
