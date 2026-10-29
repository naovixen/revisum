// One dependency review per third-party package on the trust path, transcribed from
// docs/decisions/browser-and-audit-dependencies.md. tools/check-dependency-reviews.ts keeps them
// true against package-lock.json and the manifests. Add a review here, and its decision record in
// docs/decisions/, before a package gains a new runtime dependency.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import type { DependencyReview } from './check-dependency-reviews.ts';

export const DEPENDENCY_REVIEWS: readonly DependencyReview[] = [
  {
    component: 'axe-core',
    version: '4.14.0',
    results: {
      // MPL-2.0, file-level copyleft; the files ship unmodified.
      licenceAllowsUse: 'pass',
      // Runs in any web page, on every browser engine.
      reachesAllTargets: 'pass',
      versionPinned: 'pass',
      // Needs no browser build of its own.
      stockBrowsersOnly: 'pass',
      // Its keyboard and focus gap is closed by the own engine's probes running beside it.
      gapsClosable: 'pass',
      // Watched: contributions go through a vendor licence agreement.
      roadmapFits: 'pass',
    },
    decision: 'default',
    evidence: [
      'docs/decisions/browser-and-audit-dependencies.md',
      'licences.json',
      'test/unit/auditor-act/rule-set.test.ts#no engine source mentions or imports axe-core, which stays pinned at 4.14.0 in its own auditor',
      'test/proofs/licence-roles.test.ts',
    ],
  },
  {
    component: 'playwright-core',
    version: '1.64.1',
    results: {
      licenceAllowsUse: 'pass',
      // No branded Safari or Firefox, and no real iOS devices.
      reachesAllTargets: 'fail',
      // Exact version; it pins its own browser builds.
      versionPinned: 'pass',
      // Its Firefox and WebKit builds are patched.
      stockBrowsersOnly: 'fail',
      // It is a driver, not an accessibility engine.
      gapsClosable: 'pass',
      // One vendor controls it, and it has dropped platforms before.
      roadmapFits: 'partial',
    },
    decision: 'optional-adapter',
    evidence: [
      'docs/decisions/browser-and-audit-dependencies.md',
      'test/contract/driver-contract.test.ts',
    ],
  },
];
