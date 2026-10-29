// Shared examples for the isolated runner's tests: branded values the tests build from their own
// constants, egress policies, a fake name resolver that never touches the network, and the
// undeclared hosts the fixture pages send traffic to.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import type { DeclaredService, EgressPolicy, ImageDigest, Origin, ServiceName } from '@revisum/contracts';
import { buildEgressPolicy, type AddressResolver, type ResponseRewrite } from '@revisum/runner';

// The tests' own constants stand in for values the trusted project's parser would have checked,
// so they are used as the branded values directly.
export const origin = (text: string): Origin => new URL(text).origin as Origin;
export const serviceName = (text: string): ServiceName => text as ServiceName;
export const imageDigest = (text: string): ImageDigest => text as ImageDigest;
export const declaredService = (name: string, serviceOrigin: string, isPrivate: boolean): DeclaredService =>
  ({ name: serviceName(name), origin: origin(serviceOrigin), private: isPrivate });

// Two well-formed image digests that differ.
export const PINNED_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
export const OTHER_IMAGE_ID = `sha256:${'b'.repeat(64)}`;

// The undeclared host each channel's fixture page sends its traffic to. Every one ends in
// .invalid, a name that can never resolve, so nothing reaches the network even if unblocked.
export const CHANNEL_HOSTS = {
  page: 'page.invalid',
  websocket: 'socket.invalid',
  worker: 'worker.invalid',
  popup: 'popup.invalid',
  redirect: 'redirect.invalid',
  beacon: 'beacon.invalid',
} as const;
export type ChannelName = keyof typeof CHANNEL_HOSTS;
export const CHANNEL_NAMES = Object.keys(CHANNEL_HOSTS) as ChannelName[];
// The fixture page that sends each channel's traffic.
export const CHANNEL_PAGES: { readonly [Channel in ChannelName]: string } = {
  page: '/page.html', websocket: '/websocket.html', worker: '/worker.html', popup: '/popup.html', redirect: '/redirect.html', beacon: '/beacon.html',
};
// Every undeclared origin the channel pages use, by scheme, for a browser allow-list that lets
// them all through so that only the proxy stands in their way.
export const UNDECLARED_CHANNEL_ORIGINS: readonly string[] = [
  'http://page.invalid', 'ws://socket.invalid', 'http://worker.invalid', 'http://popup.invalid', 'http://redirect.invalid', 'http://beacon.invalid',
];

// The host of an origin as the proxy or the browser records it: "scheme://host[:port]", or a bare
// "host:port" for a tunnel whose scheme the proxy cannot see.
export function hostOf(recorded: string): string {
  const withoutScheme = recorded.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const bracketed = /^\[([^\]]+)\]/.exec(withoutScheme);
  if (bracketed !== null) return bracketed[1] ?? '';
  return withoutScheme.split(/[:/]/)[0] ?? '';
}

export type PolicyInput = {
  readonly allowOrigins?: readonly string[];
  readonly allowServices?: readonly string[];
  readonly fixtureOrigins?: readonly string[];
  readonly responseRewrites?: readonly { readonly origin: string; readonly rewrite: ResponseRewrite }[];
};

// An egress policy built through the runner's own builder, which must accept it.
export function egressPolicy(input: PolicyInput): EgressPolicy {
  const built = buildEgressPolicy({
    allowOrigins: (input.allowOrigins ?? []).map(origin),
    allowServices: (input.allowServices ?? []).map(serviceName),
    ...(input.fixtureOrigins === undefined ? {} : { fixtureOrigins: input.fixtureOrigins.map(origin) }),
    ...(input.responseRewrites === undefined ? {} : {
      responseRewrites: input.responseRewrites.map((entry) => ({ origin: origin(entry.origin), rewrite: entry.rewrite })),
    }),
  });
  assert.ok(built.ok, `the test policy is accepted: ${built.ok ? '' : JSON.stringify(built.error)}`);
  return built.value;
}

// A resolver that answers from a fixed table and records every name it is asked for. A name
// whose answers are a list of lists answers each lookup with the next list, then keeps the last,
// so a test can change what a name resolves to between lookups, as a rebinding attacker would.
export type FakeResolver = { readonly resolve: AddressResolver; readonly asked: readonly string[]; lookupsOf(hostname: string): number };

export function fakeResolver(table: Readonly<Record<string, readonly string[] | readonly (readonly string[])[]>>): FakeResolver {
  const asked: string[] = [];
  const resolve: AddressResolver = async (hostname) => {
    asked.push(hostname);
    const answers = Object.hasOwn(table, hostname) ? table[hostname] : undefined;
    if (answers === undefined) throw new Error(`the fake resolver has no answer for ${hostname}`);
    const lists = answers.length > 0 && Array.isArray(answers[0]) ? answers as readonly (readonly string[])[] : [answers as readonly string[]];
    const lookup = asked.filter((name) => name === hostname).length;
    return lists[Math.min(lookup, lists.length) - 1] ?? [];
  };
  return { resolve, asked, lookupsOf: (hostname) => asked.filter((name) => name === hostname).length };
}
