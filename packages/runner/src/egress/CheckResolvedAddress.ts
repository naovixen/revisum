// The resolve-time address check. The egress proxy resolves every name itself and checks what a
// lookup found before it connects, so a declared name that points at the machine, the private network
// or a cloud's metadata service is refused, however the address is written: a DNS name, an IPv4
// literal or an IPv6 form that carries an IPv4 address inside. Everything here is pure: what a name
// resolved to earlier in a run is the proxy's to remember.
import { isIPv4, isIPv6 } from "node:net";

export type AddressVerdict = "allowed" | "refused";

export type AddressCheckOptions = {
    // True for a declared private service, such as a test API on the CI machine: it may reach
    // private and loopback addresses, but never one that is refused for every origin.
    readonly privateService?: boolean;
};

const AddressClass = {
    Public: "public",
    Private: "private",
    AlwaysRefused: "always-refused",
} as const;
type AddressClass = (typeof AddressClass)[keyof typeof AddressClass];

// The class a name keeps for a run. Every address it resolves to has to share it.
export type NameClass = typeof AddressClass.Public | typeof AddressClass.Private;

export type LookupCheckOptions = {
    readonly privateService: boolean;
    // The class the name's first accepted lookup gave it, if it has had one.
    readonly fixedClass: NameClass | undefined;
};

// An IPv4 range as its first address (a 32-bit number) and its prefix length.
type Ipv4Range = { readonly first: number; readonly prefixLength: number };

const ipv4Number = (address: string): number =>
    address.split(".").reduce((total, part) => total * 256 + Number(part), 0);

const range = (first: string, prefixLength: number): Ipv4Range => ({
    first: ipv4Number(first),
    prefixLength,
});

const inRange = (value: number, candidate: Ipv4Range): boolean => {
    const size = 2 ** (32 - candidate.prefixLength);
    return value >= candidate.first && value < candidate.first + size;
};

const LOOPBACK_IPV4_RANGE = range("127.0.0.0", 8);

// Out of reach whatever an origin is declared as. All of link-local goes, because the metadata
// services of ECS, EKS and GCP live there at several addresses. The other two are Azure's and Alibaba
// Cloud's metadata services.
const ALWAYS_REFUSED_IPV4_RANGES: readonly Ipv4Range[] = [
    range("169.254.0.0", 16),
    range("168.63.129.16", 32),
    range("100.100.100.200", 32),
];

// Never the public internet: this network, private, shared (carrier-grade NAT), loopback, private,
// protocol assignments, private, benchmarking, and multicast with everything above it.
const PRIVATE_IPV4_RANGES: readonly Ipv4Range[] = [
    range("0.0.0.0", 8),
    range("10.0.0.0", 8),
    range("100.64.0.0", 10),
    LOOPBACK_IPV4_RANGE,
    range("172.16.0.0", 12),
    range("192.0.0.0", 24),
    range("192.168.0.0", 16),
    range("198.18.0.0", 15),
    range("224.0.0.0", 3),
];

// The metadata services of AWS and GCP, as eight 16-bit groups.
const METADATA_IPV6_ADDRESSES: readonly (readonly number[])[] = [
    [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254],
    [0xfd20, 0x00ce, 0, 0, 0, 0, 0, 0x0254],
];

function ipv4Class(value: number): AddressClass {
    if (ALWAYS_REFUSED_IPV4_RANGES.some((candidate) => inRange(value, candidate))) {
        return AddressClass.AlwaysRefused;
    }
    return PRIVATE_IPV4_RANGES.some((candidate) => inRange(value, candidate))
        ? AddressClass.Private
        : AddressClass.Public;
}

// The eight 16-bit groups of an IPv6 address, with "::" expanded and a trailing dotted IPv4 part
// turned into two groups. The zone ("%eth0") is dropped: it names an interface, not an address.
function ipv6Groups(address: string): readonly number[] | null {
    const withoutZone = address.split("%")[0] ?? "";
    if (!isIPv6(withoutZone)) {
        return null;
    }
    let text = withoutZone.toLowerCase();
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (dotted?.[1] !== undefined) {
        const value = ipv4Number(dotted[1]);
        text = `${text.slice(0, -dotted[1].length)}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
    }
    const [head = "", tail] = text.split("::");
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
    const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
    const groups = [
        ...headGroups,
        ...Array.from({ length: missing }, () => "0"),
        ...tailGroups,
    ].map((group) => Number.parseInt(group, 16));
    return groups.length === 8 &&
        groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
        ? groups
        : null;
}

const areZero = (groups: readonly number[], count: number): boolean =>
    groups.slice(0, count).every((group) => group === 0);

const ipv4FromGroups = (high: number, low: number): number => high * 65536 + low;

const lastTwoGroupsAsIpv4 = (groups: readonly number[]): number =>
    ipv4FromGroups(groups[6] ?? 0, groups[7] ?? 0);

const isIpv4Mapped = (groups: readonly number[]): boolean =>
    areZero(groups, 5) && groups[5] === 0xffff;

// The IPv4 address an IPv6 form carries, by which it is judged, or null when it carries none. The
// unspecified address (as 0.0.0.0), loopback (as 0.0.0.1) and the IPv4-compatible forms all start with
// six zero groups.
function carriedIpv4(groups: readonly number[]): number | null {
    const [first = 0, second = 0, third = 0] = groups;
    const isNat64 =
        first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
    if (isIpv4Mapped(groups) || isNat64 || areZero(groups, 6)) {
        return lastTwoGroupsAsIpv4(groups);
    }
    return first === 0x2002 ? ipv4FromGroups(second, third) : null;
}

function ipv6Class(groups: readonly number[]): AddressClass {
    const [first = 0, second = 0, third = 0] = groups;
    const isMetadata = METADATA_IPV6_ADDRESSES.some((metadata) =>
        metadata.every((group, index) => group === groups[index]),
    );
    const isLinkLocal = (first & 0xffc0) === 0xfe80;
    if (isMetadata || isLinkLocal) {
        return AddressClass.AlwaysRefused;
    }
    // Translation and tunnelling ranges are refused whatever they hold: what lies behind them is decided
    // elsewhere, so no check here can vouch for it. IPv4-translated (::ffff:0:0/96), local NAT64
    // (64:ff9b:1::/48) and Teredo (2001::/32).
    const isIpv4Translated = areZero(groups, 4) && groups[4] === 0xffff && groups[5] === 0;
    const isLocalNat64 = first === 0x64 && second === 0xff9b && third === 1;
    const isTeredo = first === 0x2001 && second === 0;
    if (isIpv4Translated || isLocalNat64 || isTeredo) {
        return AddressClass.AlwaysRefused;
    }
    const carried = carriedIpv4(groups);
    if (carried !== null) {
        return ipv4Class(carried);
    }
    // Unique local (fc00::/7), site-local (fec0::/10) and multicast (ff00::/8).
    const isPrivate =
        (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
    return isPrivate ? AddressClass.Private : AddressClass.Public;
}

// Anything that is not an address is refused.
function classOfAddress(address: string): AddressClass {
    if (isIPv4(address)) {
        return ipv4Class(ipv4Number(address));
    }
    const groups = ipv6Groups(address);
    return groups === null ? AddressClass.AlwaysRefused : ipv6Class(groups);
}

// The class one lookup gives its name, or null when the lookup is refused. Its addresses have to fit
// one class, so a name with public and private addresses together is refused even for a private
// service, and that class has to be the one the name already has. An attacker's DNS could otherwise
// point a declared public name into the customer's network mid-run.
export function classOfLookup(
    addresses: readonly string[],
    options: LookupCheckOptions,
): NameClass | null {
    const classes = new Set(addresses.map(classOfAddress));
    const [nameClass] = classes;
    if (classes.size !== 1 || nameClass === undefined || nameClass === AddressClass.AlwaysRefused) {
        return null;
    }
    if (nameClass === AddressClass.Private && !options.privateService) {
        return null;
    }
    if (options.fixedClass !== undefined && options.fixedClass !== nameClass) {
        return null;
    }
    return nameClass;
}

// Whether the proxy may connect to `address`, a resolved IPv4 or IPv6 address, for a name with no
// earlier lookup.
export function checkResolvedAddress(
    address: string,
    options: AddressCheckOptions = {},
): AddressVerdict {
    const lookupOptions = {
        privateService: options.privateService === true,
        fixedClass: undefined,
    };
    return classOfLookup([address], lookupOptions) === null ? "refused" : "allowed";
}

// Whether a connection to `address` stays on this machine. An IPv6 form that carries 127.0.0.1 through
// NAT64 or 6to4 doesn't, because it goes to a gateway first.
export function isLoopbackAddress(address: string): boolean {
    if (isIPv4(address)) {
        return inRange(ipv4Number(address), LOOPBACK_IPV4_RANGE);
    }
    const groups = ipv6Groups(address);
    if (groups === null) {
        return false;
    }
    const isIpv6Loopback = areZero(groups, 7) && groups[7] === 1;
    return (
        isIpv6Loopback ||
        (isIpv4Mapped(groups) && inRange(lastTwoGroupsAsIpv4(groups), LOOPBACK_IPV4_RANGE))
    );
}
