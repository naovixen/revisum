// Whether the host paths a workload or a removal would mount can be: the output folder must be
// absolute, and every path safe to name in a Docker mount argument.
import { isAbsolute } from "node:path";
import { isSafeInMountArgument } from "./IsSafeInMountArgument.ts";

export const areMountablePaths = (
    outputDirectory: string,
    otherHostPaths: readonly string[],
): boolean =>
    isAbsolute(outputDirectory) &&
    [outputDirectory, ...otherHostPaths].every((path) => isSafeInMountArgument(path));
