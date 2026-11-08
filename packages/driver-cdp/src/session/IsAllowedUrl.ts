// Whether the session's egress allow-list lets a page load a URL.

// Schemes the page may load without an allow-list check: they never reach the network.
const LOCAL_SCHEMES = ["data:", "about:", "blob:", "chrome-error:"];

export const isAllowedUrl = (url: URL, allowedOrigins: readonly string[]): boolean =>
    allowedOrigins.includes(url.origin) || LOCAL_SCHEMES.includes(url.protocol);
