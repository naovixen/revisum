import { NavigateScripts, type NavigateOptions } from "@revisum/contracts";

// A navigate that runs the page's scripts as usual, as every test that isn't about scripts wants.
export const scriptsEnabled: NavigateOptions = { scripts: NavigateScripts.Enabled };
