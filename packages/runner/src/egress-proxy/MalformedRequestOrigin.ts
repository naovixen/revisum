// How a decision names a request too malformed to name an origin. The reader of the proxy's file
// drops a decision with no origin, and the request's own text could hold anything, so neither is used.
export const MALFORMED_REQUEST_ORIGIN = "malformed-request";
