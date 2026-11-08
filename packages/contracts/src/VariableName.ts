import type { Brand } from "./brand.ts";

// The name of an environment variable a command is given, checked by the runner: no "=", no space and
// no control character, so Docker can never read it as NAME=value.
export type VariableName = Brand<string, "VariableName">;
