// Builds a run's egress policy from the trusted project's origins and services. A browser mutant's
// response rewrite is accepted only on a declared fixture origin, so a mutant can never change
// what the real app or a third party sends. See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { failure, success, type EgressPolicy, type FixtureRewrite, type Origin, type Result, type ServiceName } from '@revisum/contracts';

export type EgressPolicyInput = {
  readonly allowOrigins: readonly Origin[];
  readonly allowServices: readonly ServiceName[];
  // Origins that serve the project's own fixture apps, the only ones a rewrite may change.
  readonly fixtureOrigins?: readonly Origin[];
  readonly responseRewrites?: readonly FixtureRewrite[];
};

export type EgressPolicyError = { readonly code: 'rewrite-origin-not-fixture'; readonly origin: Origin };

export function buildEgressPolicy(input: EgressPolicyInput): Result<EgressPolicy, EgressPolicyError> {
  const fixtureOrigins = input.fixtureOrigins ?? [];
  const rewrites = input.responseRewrites ?? [];
  const outside = rewrites.find((entry) => !fixtureOrigins.includes(entry.origin));
  if (outside !== undefined) return failure({ code: 'rewrite-origin-not-fixture', origin: outside.origin });
  return success({
    allowOrigins: [...input.allowOrigins],
    allowServices: [...input.allowServices],
    denyPrivateRanges: true,
    ...(rewrites.length === 0 ? {} : { responseRewrites: [...rewrites] }),
  });
}
