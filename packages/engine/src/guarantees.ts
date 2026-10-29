// What a run vouches for. One function decides, for every run, which guarantees hold and why each
// lost one is lost, so a plan run and an evidence run can never describe themselves differently
// for the same conditions. The level is the summary: 'isolated' only when every guarantee holds.
// See docs/specs/SPEC-35-evidence-mode.md and docs/specs/SPEC-36-unsafe-plan-features.md.
import {
  GUARANTEE_IDS,
  type GuaranteeId, type GuaranteeLossReason, type GuaranteeStatement, type RunMode, type UnsafeFeature,
} from '@revisum/contracts';

export type GuaranteeConditions = {
  readonly mode: RunMode;
  // True when every request went through the isolated runner's egress proxy.
  readonly egressEnforced: boolean;
  // True when the suite's own, unmasked screenshots are kept as artefacts.
  readonly unmaskedScreenshotsKept: boolean;
  // The unsafe features the run's plan uses (unsafeFeaturesOf); empty for a closed plan and for an
  // evidence run.
  readonly unsafeFeatures: readonly UnsafeFeature[];
};

// The guarantees each unsafe feature gives up, and only those. Egress control, no ambient
// credentials and secret redaction hold whatever a plan uses, and so does every person's approval
// of the declarations it names.
//   - CSS and XPath find elements by page structure, so a pass does not show a person or assistive
//     technology can find the control.
//   - DOM checks read implementation details, not what a user perceives.
//   - A page script runs arbitrary code in the page: it can act with synthetic events the runtime
//     guard never sees, read whatever the page holds and change the page before a capture is masked.
//   - A database command is the team's own program, judged only by its declaration, and replay
//     reuses its recorded output, which cannot show the database was in the same state.
const LOST_TO_FEATURE: { readonly [Feature in UnsafeFeature]: readonly GuaranteeId[] } = {
  'css-locator': ['semantic-locators'],
  'xpath-locator': ['semantic-locators'],
  'dom-checks': ['observable-checks'],
  'page-script': ['plan-closed', 'actions-guarded', 'observable-checks', 'pii-masked'],
  'inline-page-script': ['plan-closed', 'actions-guarded', 'observable-checks', 'pii-masked'],
  'database-command': ['plan-closed', 'actions-guarded', 'replay-identical'],
};

// Why `guarantee` does not hold under the run's mode and isolation alone, or undefined when it holds.
function conditionReason(guarantee: GuaranteeId, conditions: GuaranteeConditions): GuaranteeLossReason | undefined {
  switch (guarantee) {
    // The team's own test code drives the page, finds elements and decides what passes.
    case 'plan-closed': case 'actions-guarded': case 'semantic-locators': case 'observable-checks':
      return conditions.mode === 'evidence' ? 'evidence-mode' : undefined;
    // Suite code, the suite's browser and the app server it starts cannot be pinned; and without
    // egress control, nor can what a plan run's page reaches.
    case 'replay-identical':
      if (conditions.mode === 'evidence') return 'evidence-mode';
      return conditions.egressEnforced ? undefined : 'egress-unenforceable';
    // Only the isolated runner routes every process through the proxy and keeps credentials out.
    case 'egress-enforced': case 'no-ambient-credentials':
      return conditions.egressEnforced ? undefined : 'egress-unenforceable';
    // Every output passes through the redactor, whatever produced the text.
    case 'secrets-redacted':
      return undefined;
    // Revisum's own captures are masked; the suite's screenshots are not.
    case 'pii-masked':
      return conditions.unmaskedScreenshotsKept ? 'evidence-mode' : undefined;
  }
}

// Every reason `guarantee` is lost: the run's conditions first, then each unsafe feature that
// gives it up, in the order the features are given.
function lossReasons(guarantee: GuaranteeId, conditions: GuaranteeConditions): GuaranteeLossReason[] {
  const condition = conditionReason(guarantee, conditions);
  const features = conditions.unsafeFeatures.filter((feature) => LOST_TO_FEATURE[feature].includes(guarantee));
  return [...(condition === undefined ? [] : [condition]), ...features];
}

export function guaranteeStatement(conditions: GuaranteeConditions): GuaranteeStatement {
  const holds: GuaranteeId[] = [];
  const lost: { readonly guarantee: GuaranteeId; readonly because: GuaranteeLossReason }[] = [];
  for (const guarantee of GUARANTEE_IDS) {
    const reasons = lossReasons(guarantee, conditions);
    if (reasons.length === 0) holds.push(guarantee);
    else lost.push(...reasons.map((because) => ({ guarantee, because })));
  }
  return { level: lost.length === 0 ? 'isolated' : 'host', holds, lost };
}
