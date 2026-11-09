// A suite's report is unknown until it is decoded, and the decoder promises an answer for every
// value it is handed, not just for what JSON.parse makes. A field whose getter throws, a proxy that
// throws or a list with no prototype is refused where it sits, and never thrown. A refusal may name
// the value or a field inside it, so each is checked as refused at or under the value's place.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    listWithThrowingFirstItem,
    listWithoutPrototype,
    proxyThatThrows,
    revokedProxy,
    withThrowingGetter,
} from "#test-support/ProxyThatThrows.ts";
import { decodeReport, recordedReport, specJsonPath, specPath } from "./examples/EvidenceRun.ts";
import { withValue } from "../plan/examples/GoldenPlan.ts";

const REPORT = "each-outcome";
const SPECS_PATH = specPath(0).slice(0, -1);
const SPECS_JSON_PATH = "$.suites[0].suites[0].specs";

const report = (): object => recordedReport(REPORT);
const withSuites = (suites: unknown): unknown => withValue(report(), ["suites"], suites);
const withSpecs = (specs: unknown): unknown => withValue(report(), SPECS_PATH, specs);
const withFirstSpec = (spec: unknown): unknown => withValue(report(), specPath(0), spec);

const firstSpec = (): object => {
    const spec = specPath(0).reduce<unknown>(
        (holder, segment) => Reflect.get(Object(holder), segment),
        report(),
    );
    assert.ok(typeof spec === "object" && spec !== null, "the report has no first spec");
    return spec;
};

const HOSTILE_REPORTS: readonly {
    readonly name: string;
    readonly hostile: () => unknown;
    readonly place: string;
}[] = [
    {
        name: "a report whose suites field has a getter that throws",
        hostile: () => withThrowingGetter(report(), "suites"),
        place: "$",
    },
    {
        name: "a proxy that throws on every read as the report",
        hostile: () => proxyThatThrows(report()),
        place: "$",
    },
    { name: "a revoked proxy as the report", hostile: () => revokedProxy(report()), place: "$" },
    {
        name: "the suites in a proxy over a list that throws on every read",
        hostile: () => withSuites(proxyThatThrows([])),
        place: "$.suites",
    },
    {
        name: "the suites in a revoked proxy over a list",
        hostile: () => withSuites(revokedProxy([])),
        place: "$.suites",
    },
    {
        name: "the suites in a list with no prototype",
        hostile: () => withSuites(listWithoutPrototype([])),
        place: "$.suites",
    },
    {
        name: "a list of specs whose first item has a getter that throws",
        hostile: () => withSpecs(listWithThrowingFirstItem([{}])),
        place: SPECS_JSON_PATH,
    },
    {
        name: "a first spec whose title has a getter that throws",
        hostile: () => withFirstSpec(withThrowingGetter(firstSpec(), "title")),
        place: specJsonPath(0),
    },
    {
        name: "a first spec that is a proxy throwing on every read",
        hostile: () => withFirstSpec(proxyThatThrows(firstSpec())),
        place: specJsonPath(0),
    },
    {
        name: "a first spec that is a revoked proxy",
        hostile: () => withFirstSpec(revokedProxy(firstSpec())),
        place: specJsonPath(0),
    },
];

describe("Using parseSuiteReport", () => {
    for (const { name, hostile, place } of HOSTILE_REPORTS) {
        describe(`given ${name}`, () => {
            describe("when it is decoded", () => {
                test(`then it should refuse it at or under ${place} without throwing`, () => {
                    const input = hostile();
                    let decoded: ReturnType<typeof decodeReport> | undefined;
                    assert.doesNotThrow(() => {
                        decoded = decodeReport(input);
                    });
                    assert.ok(decoded !== undefined && !decoded.ok, "the report was accepted");
                    const [refusal, ...others] = decoded.error;
                    assert.deepEqual(others, []);
                    assert.equal(refusal?.code, "suite-report-invalid");
                    assert.ok(
                        refusal.path.startsWith(place),
                        `${refusal.path} is not at or under ${place}`,
                    );
                });
            });
        });
    }
});
