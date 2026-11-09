// One dependency review per third-party package on the trust path, transcribed from
// docs/decisions/browser-and-audit-dependencies.md. tools/repo-rules/docs/CheckDependencyReviews.ts keeps them
// true against package-lock.json and the manifests. Add a review here, and its decision record in
// docs/decisions/, before a package gains a new runtime dependency.

// The checks every third-party component on the trust path must pass to stay on the default path.
export type DependencyCheck =
  | 'licenceAllowsUse'     // its licence permits commercial use and distribution
  | 'reachesAllTargets'    // it can drive or run on every target the product must support
  | 'versionPinned'        // an exact version can be pinned and run hermetically
  | 'stockBrowsersOnly'    // it needs no patched or vendor-only browser build
  | 'gapsClosable'         // any accessibility coverage gap can be closed around it
  | 'roadmapFits';         // its roadmap can't break the product's guarantees

export const DependencyCheckResult = {
  Pass: 'pass',
  Fail: 'fail',
  Partial: 'partial',
} as const;

export type DependencyCheckResult = (typeof DependencyCheckResult)[keyof typeof DependencyCheckResult];

// One review per third-party component on the trust path.
export type DependencyReview = {
  readonly component: string;
  // Exact and pinned.
  readonly version: string;
  readonly results: Readonly<Record<DependencyCheck, DependencyCheckResult>>;
  readonly decision: 'default' | 'optional-adapter' | 'dropped';
  // Test ids (<file>#<name>, the name as test results give it: titles joined by " > "), licence
  // files, repository docs or vendor URLs behind the results.
  readonly evidence: readonly string[];
};

export const DEPENDENCY_REVIEWS: readonly DependencyReview[] = [
  {
    component: 'axe-core',
    version: '4.14.0',
    results: {
      // MPL-2.0, file-level copyleft; the files ship unmodified.
      licenceAllowsUse: DependencyCheckResult.Pass,
      // Runs in any web page, on every browser engine.
      reachesAllTargets: DependencyCheckResult.Pass,
      versionPinned: DependencyCheckResult.Pass,
      // Needs no browser build of its own.
      stockBrowsersOnly: DependencyCheckResult.Pass,
      // Its keyboard and focus gap is closed by the own engine's probes running beside it.
      gapsClosable: DependencyCheckResult.Pass,
      // Watched: contributions go through a vendor licence agreement.
      roadmapFits: DependencyCheckResult.Pass,
    },
    decision: 'default',
    evidence: [
      'docs/decisions/browser-and-audit-dependencies.md',
      'licences.json',
      'test/unit/auditor-act/rules/RuleSet.test.ts#no engine source mentions or imports axe-core, which stays pinned at 4.14.0 in its own auditor',
      'test/proofs/repo-rules/licences-and-reviews/LicenceRoles.test.ts',
    ],
  },
];
