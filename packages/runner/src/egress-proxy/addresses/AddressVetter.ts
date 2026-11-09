import { isIP } from "node:net";
import { classOfLookup, type NameClass } from "../../egress/CheckResolvedAddress.ts";
import type { AddressResolver } from "./AddressResolver.ts";
import { asError } from "../AsError.ts";
import type { BareHost } from "./BareHost.ts";
import type { ConnectDeadline } from "./ConnectDeadline.ts";
import { OriginDeclaration } from "./OriginDeclaration.ts";

export const VettingKind = {
    Refused: "refused",
    // The name has no address, which isn't a refusal.
    NoAddress: "no-address",
    Checked: "checked",
} as const;

// At least one, so connecting always has something to try.
export type CheckedAddresses = readonly [string, ...string[]];

export type ReachableVetting =
    | { readonly kind: typeof VettingKind.NoAddress; readonly failure: Error }
    | { readonly kind: typeof VettingKind.Checked; readonly addresses: CheckedAddresses };

export type AddressVetting = { readonly kind: typeof VettingKind.Refused } | ReachableVetting;

// Finds the addresses a target may be connected to. A resolver that rejects, or that hasn't answered
// when the deadline ends, is a name with no address.
export type AddressVetter = (
    host: BareHost,
    declaration: OriginDeclaration,
    deadline: ConnectDeadline,
) => Promise<AddressVetting>;

// These names are loopback by definition, so a lookup could only get that wrong. IPv4 goes first
// because most local apps bind it, and a refused connection can take seconds on Windows.
const LOOPBACK_ADDRESSES: CheckedAddresses = ["127.0.0.1", "::1"];

// Only the whole label counts, so "notlocalhost" and "app.localhost.attacker.test" are looked up.
function isLoopbackName(host: string): boolean {
    const name = host.toLowerCase();
    return name === "localhost" || name.endsWith(".localhost");
}

const noAddress = (failure: Error): ReachableVetting => ({
    kind: VettingKind.NoAddress,
    failure,
});

const checked = (addresses: CheckedAddresses): ReachableVetting => ({
    kind: VettingKind.Checked,
    addresses,
});

function vettingOfAnswer(host: BareHost, answer: readonly string[]): ReachableVetting {
    const [first, ...others] = answer;
    return first === undefined
        ? noAddress(new Error(`${host} resolved to no address`))
        : checked([first, ...others]);
}

async function askResolver(host: BareHost, resolve: AddressResolver): Promise<ReachableVetting> {
    try {
        return vettingOfAnswer(host, await resolve(host));
    } catch (error) {
        return noAddress(asError(error, `the lookup of ${host} failed`));
    }
}

// Settles with the lookup's answer or with the deadline's end, whichever comes first: a resolver that
// never answers must not hold the request open.
function lookedUpWithin(
    host: BareHost,
    resolve: AddressResolver,
    deadline: ConnectDeadline,
): Promise<ReachableVetting> {
    if (deadline.ended.aborted) {
        return Promise.resolve(noAddress(deadline.failure()));
    }
    return new Promise((settle) => {
        deadline.ended.addEventListener(
            "abort",
            () => {
                settle(noAddress(deadline.failure()));
            },
            { once: true },
        );
        void askResolver(host, resolve).then(settle);
    });
}

function addressesOf(
    host: BareHost,
    resolve: AddressResolver,
    deadline: ConnectDeadline,
): Promise<ReachableVetting> {
    if (isLoopbackName(host)) {
        return Promise.resolve(checked(LOOPBACK_ADDRESSES));
    }
    if (isIP(host) !== 0) {
        return Promise.resolve(checked([host]));
    }
    return lookedUpWithin(host, resolve, deadline);
}

// An undeclared target is refused before its name is looked up, so the lookup itself never leaves.
// A name's class is kept by name, not origin, so it can't change by being asked for on another port.
export function createAddressVetter(resolve: AddressResolver): AddressVetter {
    const fixedClassOfName = new Map<string, NameClass>();
    return async (host, declaration, deadline) => {
        if (declaration === OriginDeclaration.Undeclared) {
            return { kind: VettingKind.Refused };
        }
        const found = await addressesOf(host, resolve, deadline);
        if (found.kind === VettingKind.NoAddress) {
            return found;
        }
        const nameClass = classOfLookup(found.addresses, {
            privateService: declaration === OriginDeclaration.Private,
            fixedClass: fixedClassOfName.get(host),
        });
        if (nameClass === null) {
            return { kind: VettingKind.Refused };
        }
        fixedClassOfName.set(host, nameClass);
        return found;
    };
}
