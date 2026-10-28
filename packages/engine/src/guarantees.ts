// What a run vouches for. One function decides, for every run, which guarantees hold and why each
// lost one is lost, so a plan run and an evidence run can never describe themselves differently
// for the same conditions. The level is the summary: 'isolated' only when every guarantee holds.
// See docs/specs/SPEC-35-evidence-mode.md.
import {
  GUARANTEE_IDS,
  type GuaranteeId, type GuaranteeLossReason, type GuaranteeStatement, type RunMode,
} from '@revisum/contracts';

export type GuaranteeConditions = {
  readonly mode: RunMode;
  // True when every request went through the isolated runner's egress proxy.
  readonly egressEnforced: boolean;
  // True when the suite's own, unmasked screenshots are kept as artefacts.
  readonly unmaskedScreenshotsKept: boolean;
};

// Why `guarantee` does not hold under `conditions`, or undefined when it holds.
function lossReason(guarantee: GuaranteeId, conditions: GuaranteeConditions): GuaranteeLossReason | undefined {
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

export function guaranteeStatement(conditions: GuaranteeConditions): GuaranteeStatement {
  const holds: GuaranteeId[] = [];
  const lost: { readonly guarantee: GuaranteeId; readonly because: GuaranteeLossReason }[] = [];
  for (const guarantee of GUARANTEE_IDS) {
    const because = lossReason(guarantee, conditions);
    if (because === undefined) holds.push(guarantee);
    else lost.push({ guarantee, because });
  }
  return { level: lost.length === 0 ? 'isolated' : 'host', holds, lost };
}
