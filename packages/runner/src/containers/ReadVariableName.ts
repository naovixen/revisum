// The one reader of a variable name a command is given: a name Docker can never read as NAME=value.
import type { VariableName } from "@revisum/contracts";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// The run sets these itself, so a project's secret of the same name can't move the run's proxy.
const NAMES_THAT_SET_THE_PROXY = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

export function readVariableName(text: string): VariableName | null {
    return VARIABLE_NAME.test(text) && !NAMES_THAT_SET_THE_PROXY.has(text.toUpperCase())
        ? (text as VariableName)
        : null;
}
