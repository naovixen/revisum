// Who sends requests through the proxy, which decides how it says no.
export const ProxyClient = { Service: "service", Browser: "browser" } as const;
export type ProxyClient = (typeof ProxyClient)[keyof typeof ProxyClient];
