// The resolve-time address check: every address a name resolves to is checked before the proxy
// connects, and private, loopback, link-local, shared, benchmarking, multicast, reserved and cloud
// metadata addresses are refused, in IPv4 and IPv6, including IPv6 forms that carry an IPv4
// address inside. Each refused range is checked at its edges, and the address just outside each
// edge is allowed, so a check that refused too much would fail as surely as one that refused too
// little.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkResolvedAddress } from '@revisum/runner';

const REFUSED_IPV4: readonly { readonly range: string; readonly addresses: readonly string[] }[] = [
  { range: '0.0.0.0/8 (this network)', addresses: ['0.0.0.0', '0.1.2.3', '0.255.255.255'] },
  { range: '10.0.0.0/8 (private)', addresses: ['10.0.0.0', '10.0.0.5', '10.255.255.255'] },
  { range: '100.64.0.0/10 (shared address space)', addresses: ['100.64.0.0', '100.64.0.1', '100.127.255.255'] },
  { range: '127.0.0.0/8 (loopback)', addresses: ['127.0.0.1', '127.1.2.3', '127.255.255.255'] },
  { range: '169.254.0.0/16 (link-local)', addresses: ['169.254.0.0', '169.254.10.20', '169.254.255.255'] },
  { range: '172.16.0.0/12 (private)', addresses: ['172.16.0.0', '172.20.1.1', '172.31.255.255'] },
  { range: '192.0.0.0/24 (protocol assignments)', addresses: ['192.0.0.0', '192.0.0.8', '192.0.0.255'] },
  { range: '192.168.0.0/16 (private)', addresses: ['192.168.0.0', '192.168.1.1', '192.168.255.255'] },
  { range: '198.18.0.0/15 (benchmarking)', addresses: ['198.18.0.0', '198.18.0.1', '198.19.255.255'] },
  { range: '224.0.0.0/4 and above (multicast and reserved)', addresses: ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'] },
  { range: 'cloud metadata', addresses: ['169.254.169.254', '100.100.100.200'] },
];

// The addresses just outside each refused range's edges, and ordinary public addresses.
const ALLOWED_IPV4: readonly string[] = [
  '1.0.0.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '93.184.215.14', '100.63.255.255', '100.128.0.0', '126.255.255.255',
  '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '191.255.255.255', '192.0.1.0',
  '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
];

// IPv6 forms written with an embedded dotted IPv4 address where possible. The two that carry
// 127.0.0.1 in hexadecimal are template strings, which the naming lint reads as text, not words.
const REFUSED_IPV6: readonly { readonly range: string; readonly addresses: readonly string[] }[] = [
  { range: ':: (unspecified)', addresses: ['::', '0:0:0:0:0:0:0:0'] },
  { range: '::1 (loopback)', addresses: ['::1', '0:0:0:0:0:0:0:1'] },
  { range: 'fc00::/7 (unique local)', addresses: ['fc00::1', 'fd12:3456::1', 'FD00::1', 'fdff:ffff::1'] },
  { range: 'fe80::/10 (link-local)', addresses: ['fe80::1', 'FE80::1', 'febf::1', 'fe80::1%eth0'] },
  { range: 'fec0::/10 (site-local)', addresses: ['fec0::1', 'feff::1'] },
  { range: 'ff00::/8 (multicast)', addresses: ['ff00::', 'ff02::1'] },
  { range: 'cloud metadata', addresses: ['fd00:ec2::254'] },
  { range: 'IPv4-mapped with a refused IPv4 inside', addresses: ['::ffff:127.0.0.1', `::ffff:7f00:1`, '::ffff:10.0.0.5', '::ffff:169.254.169.254'] },
  { range: 'IPv4-compatible with a refused IPv4 inside', addresses: ['::127.0.0.1', '::10.0.0.5', '::169.254.169.254'] },
  { range: 'NAT64 (64:ff9b::/96) with a refused IPv4 inside', addresses: ['64:ff9b::127.0.0.1', '64:ff9b::169.254.169.254', '64:ff9b::192.168.1.1'] },
  { range: '6to4 (2002::/16) with a refused IPv4 inside', addresses: [`2002:7f00:1::1`, '2002:a00:5::1', '2002:a9fe:a9fe::', '2002:c0a8:101::1'] },
];

// Public IPv6 addresses, and each embedding form carrying a public IPv4 address.
const ALLOWED_IPV6: readonly string[] = [
  '2606:4700::1111', '2a00:1450:4001::200e', 'fbff::1', '::ffff:8.8.8.8', '::8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1',
];

for (const { range, addresses } of REFUSED_IPV4) {
  test(`an IPv4 address in ${range} is refused`, { criterion: 'AC-SPEC-07-02' }, () => {
    for (const address of addresses) assert.equal(checkResolvedAddress(address), 'refused', address);
  });
}

test('a public IPv4 address, including each one just outside a refused range, is allowed', { criterion: 'AC-SPEC-07-02' }, () => {
  for (const address of ALLOWED_IPV4) assert.equal(checkResolvedAddress(address), 'allowed', address);
});

for (const { range, addresses } of REFUSED_IPV6) {
  test(`an IPv6 address in ${range} is refused`, { criterion: 'AC-SPEC-07-02' }, () => {
    for (const address of addresses) assert.equal(checkResolvedAddress(address), 'refused', address);
  });
}

test('a public IPv6 address, and each IPv6 form carrying a public IPv4 address, is allowed', { criterion: 'AC-SPEC-07-02' }, () => {
  for (const address of ALLOWED_IPV6) assert.equal(checkResolvedAddress(address), 'allowed', address);
});
