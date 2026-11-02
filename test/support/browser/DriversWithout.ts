import assert from "node:assert/strict";
import type { BrowserDriver, DriverFeature } from "@revisum/engine";
import { DriverAdapter } from "./BrowserTarget.ts";
import { driverWith } from "./WrappingSessions.ts";

type HoldingDrivers = { readonly drivers: ReadonlyMap<string, BrowserDriver> };

// The features a driver lists, as plain names.
export const listedFeatures = (driver: BrowserDriver | undefined): readonly string[] => {
    assert.ok(driver !== undefined, "the harness has the driver");
    return (driver.info.performs ?? []).map((feature) => String(feature));
};

// The harness's drivers with one adapter's list lacking one feature, and nothing else changed.
export function driversWithout(
    harness: HoldingDrivers,
    adapter: string,
    feature: DriverFeature,
): ReadonlyMap<string, BrowserDriver> {
    const inner = harness.drivers.get(adapter);
    assert.ok(inner !== undefined, `the harness has the ${adapter} driver`);
    const performs = (inner.info.performs ?? []).filter((listed) => listed !== feature);
    const lacking = driverWith(inner, { info: { ...inner.info, performs } });
    return new Map([...harness.drivers, [adapter, lacking]]);
}

export const cdpWithout = (
    harness: HoldingDrivers,
    feature: DriverFeature,
): ReadonlyMap<string, BrowserDriver> => driversWithout(harness, DriverAdapter.Cdp, feature);
