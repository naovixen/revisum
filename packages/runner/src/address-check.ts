// The resolve-time address check. The egress proxy resolves every name itself and checks each
// address before it connects, so a declared name that points at the machine, the private network
// or a cloud's metadata service is refused, however the address is written: a DNS name, an IPv4
// literal or an IPv6 form that carries an IPv4 address inside.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { isIPv4, isIPv6 } from 'node:net';

export type AddressVerdict = 'allowed' | 'refused';

export type AddressCheckOptions = {
  // True for a declared private service, such as a test API on the CI machine: it may reach
  // private and loopback addresses, but never a metadata address.
  readonly privateService?: boolean;
};

// An IPv4 range as its first address (a 32-bit number) and its prefix length.
type Ipv4Range = { readonly first: number; readonly prefixLength: number };

const ipv4Number = (address: string): number =>
  address.split('.').reduce((total, part) => total * 256 + Number(part), 0);

const range = (first: string, prefixLength: number): Ipv4Range => ({ first: ipv4Number(first), prefixLength });

// Never the public internet: this network, private, shared (carrier-grade NAT), loopback,
// link-local, protocol assignments, private, benchmarking, and multicast with everything above it.
const REFUSED_IPV4_RANGES: readonly Ipv4Range[] = [
  range('0.0.0.0', 8), range('10.0.0.0', 8), range('100.64.0.0', 10), range('127.0.0.0', 8), range('169.254.0.0', 16),
  range('172.16.0.0', 12), range('192.0.0.0', 24), range('192.168.0.0', 16), range('198.18.0.0', 15), range('224.0.0.0', 3),
];

// Cloud metadata services: AWS, GCP and Azure (IPv4), AWS (IPv6) and Alibaba Cloud.
const METADATA_IPV4 = new Set([ipv4Number('169.254.169.254'), ipv4Number('100.100.100.200')]);
const METADATA_IPV6 = '0xfd00:0xec2:0:0:0:0:0:0x254';

const inRange = (value: number, candidate: Ipv4Range): boolean => {
  const size = 2 ** (32 - candidate.prefixLength);
  return value >= candidate.first && value < candidate.first + size;
};

function ipv4Verdict(value: number, privateService: boolean): AddressVerdict {
  if (METADATA_IPV4.has(value)) return 'refused';
  if (privateService) return 'allowed';
  return REFUSED_IPV4_RANGES.some((candidate) => inRange(value, candidate)) ? 'refused' : 'allowed';
}

// The eight 16-bit groups of an IPv6 address, with "::" expanded and a trailing dotted IPv4 part
// turned into two groups. The zone ("%eth0") is dropped: it names an interface, not an address.
function ipv6Groups(address: string): readonly number[] | null {
  const withoutZone = address.split('%')[0] ?? '';
  if (!isIPv6(withoutZone)) return null;
  let text = withoutZone.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const value = ipv4Number(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

const groupsText = (groups: readonly number[]): string => groups.map((group) => (group === 0 ? '0' : `0x${group.toString(16)}`)).join(':');

function ipv6Verdict(groups: readonly number[], privateService: boolean): AddressVerdict {
  const [first = 0, second = 0, third = 0] = groups;
  const embedded = (high: number, low: number): number => high * 65536 + low;
  const zeroUpTo = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  if (groupsText(groups) === METADATA_IPV6) return 'refused';
  // Forms that carry an IPv4 address are judged by that address, metadata included.
  if (zeroUpTo(5) && groups[5] === 0xffff) return ipv4Verdict(embedded(groups[6] ?? 0, groups[7] ?? 0), privateService);
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return ipv4Verdict(embedded(groups[6] ?? 0, groups[7] ?? 0), privateService);
  }
  if (first === 0x2002) return ipv4Verdict(embedded(second, third), privateService);
  // The unspecified address (as 0.0.0.0), loopback (as 0.0.0.1) and the IPv4-compatible forms all
  // start with six zero groups.
  if (zeroUpTo(6)) return ipv4Verdict(embedded(groups[6] ?? 0, groups[7] ?? 0), privateService);
  if (privateService) return 'allowed';
  // Unique local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10) and multicast (ff00::/8).
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) {
    return 'refused';
  }
  return 'allowed';
}

// Whether the proxy may connect to `address`, a resolved IPv4 or IPv6 address. Anything that is
// not an address is refused.
export function checkResolvedAddress(address: string, options: AddressCheckOptions = {}): AddressVerdict {
  const privateService = options.privateService === true;
  if (isIPv4(address)) return ipv4Verdict(ipv4Number(address), privateService);
  const groups = ipv6Groups(address);
  return groups === null ? 'refused' : ipv6Verdict(groups, privateService);
}
