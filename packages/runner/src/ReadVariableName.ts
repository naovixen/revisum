// The one reader of a variable name a command is given: a name Docker can never read as NAME=value.
import type { VariableName } from "@revisum/contracts";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function readVariableName(text: string): VariableName | null {
    return VARIABLE_NAME.test(text) ? (text as VariableName) : null;
}
