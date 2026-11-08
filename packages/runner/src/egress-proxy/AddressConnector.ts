import { connect as connectSocket, type Socket } from "node:net";

// Opens a TCP connection to an address the proxy has checked. The socket must report the attempt
// like a net.Socket: 'connect' once open, or 'error' or 'close' when it never will be. A connector
// that throws is one more failed connection.
export type AddressConnector = (address: string, port: number) => Socket;

export const directConnector: AddressConnector = (address, port) =>
    connectSocket({ host: address, port });
