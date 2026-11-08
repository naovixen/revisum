import { lookup } from "node:dns/promises";
import { connect as connectSocket, type Socket } from "node:net";

// Resolves a host name to every address it has. Tests pass a fake that never touches the network.
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

// Opens a TCP connection to an address the proxy has checked. The socket must report the attempt
// like a net.Socket: 'connect' once open, or 'error' or 'close' when it never will be.
export type AddressConnector = (address: string, port: number) => Socket;

export const systemResolver: AddressResolver = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export const directConnector: AddressConnector = (address, port) =>
    connectSocket({ host: address, port });
