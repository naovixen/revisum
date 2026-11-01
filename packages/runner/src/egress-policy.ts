// Builds a run's egress policy from the trusted project's origins and services. A browser mutant's
// response rewrite is accepted only on a declared fixture origin served over plain HTTP, so a mutant
// can never change what the real app or a third party sends. Only this builder knows which origins
// are fixtures; the proxy repeats what it can check when it starts, for a policy built by hand.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { failure, success, type EgressPolicy, type FixtureRewrite, type Origin, type Result, type ServiceName } from '@revisum/contracts';
import { isPlainHttpOrigin } from './egress-events.ts';

export type EgressPolicyInput = {
  readonly allowOrigins: readonly Origin[];
  readonly allowServices: readonly ServiceName[];
  // Services a database command reaches over TCP; none when absent.
  readonly allowTcpServices?: readonly ServiceName[];
  // Origins that serve the project's own fixture apps, the only ones a rewrite may change.
  readonly fixtureOrigins?: readonly Origin[];
  readonly responseRewrites?: readonly FixtureRewrite[];
};

export type EgressPolicyError = {
  readonly code: 'rewrite-origin-not-fixture' | 'fixture-origin-undeclared' | 'fixture-origin-not-plain-http';
  readonly origin: Origin;
};

export function buildEgressPolicy(input: EgressPolicyInput): Result<EgressPolicy, EgressPolicyError> {
  const fixtureOrigins = input.fixtureOrigins ?? [];
  const rewrites = input.responseRewrites ?? [];
  for (const fixture of fixtureOrigins) {
    if (!input.allowOrigins.includes(fixture)) return failure({ code: 'fixture-origin-undeclared', origin: fixture });
    if (!isPlainHttpOrigin(fixture)) return failure({ code: 'fixture-origin-not-plain-http', origin: fixture });
  }
  const outside = rewrites.find((entry) => !fixtureOrigins.includes(entry.origin));
  if (outside !== undefined) return failure({ code: 'rewrite-origin-not-fixture', origin: outside.origin });
  return success({
    allowOrigins: [...input.allowOrigins],
    allowServices: [...input.allowServices],
    allowTcpServices: [...(input.allowTcpServices ?? [])],
    denyPrivateRanges: true,
    ...(rewrites.length === 0 ? {} : { responseRewrites: [...rewrites] }),
  });
}
