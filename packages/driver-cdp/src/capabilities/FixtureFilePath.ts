// The project's declared fixtures, which an upload step sends and a stub serves, and never a file
// outside their folder.
import { DriverErrorCode, failure, success, type DriverError, type Result } from "@revisum/contracts";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { errorText } from "../connection/ErrorText.ts";

// The absolute path of a declared fixture inside the fixtures folder. A name that leads out of the
// folder, by "..", an absolute path or a link, is refused, as is a file that is not there.
export function fixtureFilePath(
    fixturesFolder: string | undefined,
    fixture: string,
): Result<string, DriverError> {
    if (fixturesFolder === undefined) {
        return failure({
            code: DriverErrorCode.UnsupportedStep,
            detail: "this driver was given no fixtures folder to upload from",
        });
    }
    let folder: string;
    let file: string;
    try {
        folder = realpathSync(fixturesFolder);
        file = realpathSync(resolve(folder, fixture));
    } catch {
        return failure({
            code: DriverErrorCode.NotFound,
            detail: "the fixture file is not in the fixtures folder",
        });
    }
    const inside = relative(folder, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        return failure({
            code: DriverErrorCode.NotActionable,
            detail: "the fixture leads outside the fixtures folder",
        });
    }
    return success(file);
}

// The bytes of a declared fixture inside the fixtures folder, for a stub's body.
export function readFixture(
    fixturesFolder: string | undefined,
    fixture: string,
): Result<Uint8Array, DriverError> {
    const path = fixtureFilePath(fixturesFolder, fixture);
    if (!path.ok) {
        return path;
    }
    try {
        return success(readFileSync(path.value));
    } catch (error) {
        return failure({
            code: DriverErrorCode.NotFound,
            detail: `the fixture could not be read: ${errorText(error)}`,
        });
    }
}
