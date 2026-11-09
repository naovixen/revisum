// A port a run was given nothing to wire to. It has no methods, so a wrapper meant for a real port
// cannot be built around one without the compiler saying so, and whether a port is wired is read
// from its type, not from which object it is.
export type UnwiredPort = { readonly unwired: true };

export const UNWIRED_PORT: UnwiredPort = { unwired: true };

export const isWiredPort = <Port extends object>(port: Port | UnwiredPort): port is Port =>
    !("unwired" in port);
