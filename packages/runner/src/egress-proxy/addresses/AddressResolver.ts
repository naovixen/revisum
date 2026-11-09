import { lookup } from "node:dns/promises";

// Resolves a host name to every address it has. Tests pass a fake that never touches the network.
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

export const systemResolver: AddressResolver = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
