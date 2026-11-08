import { isIP } from "node:net";
import { classOfLookup, type NameClass } from "../address-check.ts";
import type { AddressResolver } from "./AddressResolver.ts";
import type { BareHost } from "./BareHost.ts";
import { OriginDeclaration } from "./OriginDeclaration.ts";

export const VettingKind = {
    Refused: "refused",
    // The name has no address, which isn't a refusal.
    NoAddress: "no-address",
    Checked: "checked",
} as const;

export type ReachableVetting =
    | { readonly kind: typeof VettingKind.NoAddress; readonly failure: Error }
    | { readonly kind: typeof VettingKind.Checked; readonly addresses: readonly string[] };

export type AddressVetting = { readonly kind: typeof VettingKind.Refused } | ReachableVetting;

// Finds the addresses a target may be connected to. A resolver that rejects is a name with no address.
export type AddressVetter = (
    host: BareHost,
    declaration: OriginDeclaration,
) => Promise<AddressVetting>;

// These names are loopback by definition, so a lookup could only get that wrong. IPv4 goes first
// because most local apps bind it, and a refused connection can take seconds on Windows.
const LOOPBACK_ADDRESSES: readonly string[] = ["127.0.0.1", "::1"];

// Only the whole label counts, so "notlocalhost" and "app.localhost.attacker.test" are looked up.
function isLoopbackName(host: string): boolean {
    const name = host.toLowerCase();
    return name === "localhost" || name.endsWith(".localhost");
}

async function addressesOf(
    host: BareHost,
    resolve: AddressResolver,
): Promise<readonly string[] | Error> {
    if (isLoopbackName(host)) {
        return LOOPBACK_ADDRESSES;
    }
    if (isIP(host) !== 0) {
        return [host];
    }
    try {
        return await resolve(host);
    } catch (error) {
        return error instanceof Error
            ? error
            : new Error(`the lookup of ${host} failed: ${String(error)}`);
    }
}

// An undeclared target is refused before its name is looked up, so the lookup itself never leaves.
// A name's class is kept by name, not origin, so it can't change by being asked for on another port.
export function createAddressVetter(resolve: AddressResolver): AddressVetter {
    const fixedClassOfName = new Map<string, NameClass>();
    return async (host, declaration) => {
        if (declaration === OriginDeclaration.Undeclared) {
            return { kind: VettingKind.Refused };
        }
        const addresses = await addressesOf(host, resolve);
        if (addresses instanceof Error) {
            return { kind: VettingKind.NoAddress, failure: addresses };
        }
        if (addresses.length === 0) {
            return {
                kind: VettingKind.NoAddress,
                failure: new Error(`${host} resolved to no address`),
            };
        }
        const nameClass = classOfLookup(addresses, {
            privateService: declaration === OriginDeclaration.Private,
            fixedClass: fixedClassOfName.get(host),
        });
        if (nameClass === null) {
            return { kind: VettingKind.Refused };
        }
        fixedClassOfName.set(host, nameClass);
        return { kind: VettingKind.Checked, addresses };
    };
}
