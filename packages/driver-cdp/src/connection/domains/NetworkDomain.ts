// The commands of the browser's network domain.
import { browserCommand, NOTHING_TO_READ } from "../BrowserCommand.ts";

export const NETWORK_DOMAIN = "Network";

export const SET_BYPASS_SERVICE_WORKER = browserCommand<{ readonly bypass: boolean }>()(
    `${NETWORK_DOMAIN}.setBypassServiceWorker`,
    NOTHING_TO_READ,
);
