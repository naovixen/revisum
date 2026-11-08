import { bareHost, type BareHost } from "./BareHost.ts";
import { MALFORMED_REQUEST_ORIGIN } from "./MalformedRequestOrigin.ts";

// A name holds nothing the URL parser would read past: a name before an @ is a credential, and the
// tunnel would go to whatever came after it.
const AUTHORITY = /^(\[[0-9a-fA-F:.%a-zA-Z]+\]|[^:[\]/\\?#@\s]+):(\d{1,5})$/;
const LAST_PORT = 65_535;

export const ConnectTargetKind = { Malformed: "malformed", HostAndPort: "host-and-port" } as const;

// What a CONNECT request's target says, parsed once where it arrives.
export type ConnectTarget =
    | {
          readonly kind: typeof ConnectTargetKind.Malformed;
          // How the refusal names it in the proxy's decisions.
          readonly recordedAs: string;
      }
    | {
          readonly kind: typeof ConnectTargetKind.HostAndPort;
          // "host:port", as decisions name it and rules are compared, an IPv6 host in brackets.
          readonly seen: string;
          readonly host: BareHost;
          readonly port: number;
      };

export function parseConnectTarget(rawTarget: string | undefined): ConnectTarget {
    const authority = AUTHORITY.exec(rawTarget ?? "");
    const hostname = URL.parse(`http://${authority?.[1] ?? ""}`)?.hostname ?? "";
    const port = Number(authority?.[2] ?? 0);
    if (hostname === "") {
        return { kind: ConnectTargetKind.Malformed, recordedAs: MALFORMED_REQUEST_ORIGIN };
    }
    const seen = `${hostname}:${port}`;
    if (port < 1 || port > LAST_PORT) {
        return { kind: ConnectTargetKind.Malformed, recordedAs: seen };
    }
    return { kind: ConnectTargetKind.HostAndPort, seen, host: bareHost(hostname), port };
}
