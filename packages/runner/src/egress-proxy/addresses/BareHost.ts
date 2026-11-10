import type { Brand } from "@revisum/contracts";

// A host name or IP address as the proxy looks it up and connects to it: an IPv6 address has no
// brackets. Only bareHost makes one.
export type BareHost = Brand<string, "BareHost">;

// A URL's host name as a BareHost. A host that is already bare comes back as it is.
export const bareHost = (hostname: string): BareHost =>
    hostname.replace(/^\[(.*)\]$/, "$1") as BareHost;
