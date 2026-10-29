// The one door from a draft to a Plan. Every authoring route produces a PlanDraft: text or JSON,
// with an optional declared provenance. admitDraft reads it, calls the plan parser it is given
// exactly once, returns the parser's own Plan, and appends one plan.submitted or plan.rejected audit
// event that carries the draft's source and basis. Nothing reaches the policy gate or a driver
// before that parse, and the source changes nothing: the same plan gets the same hash, policy
// decision and approval requirement whichever route it came by.
//
// Provenance (SPEC-28's build notes): without a declared source a draft is hand-written, basis
// declared. A caller may declare hand-written or customer-llm. Only core's own recorder produces a
// core-recorded basis (phase 2b), so a draft whose caller claims one is refused with
// untrusted-source, before the parser. A malformed JSON draft is not_object at $, also before it.
//
// The one shape the build notes leave unnamed is assumed only in draftWith() below: the declared
// source is the draft's own `provenance` field, which may be left out.
//
// There is one draft fixture per PlanSource. ROUTES is typed by PlanSource, so a source added to
// the type without a fixture here fails to compile. The routes core runs itself (draft command,
// ticket, builder, recorder, chat) do not exist in M1, so their fixtures are drafts that claim the
// core-recorded basis, as a caller impersonating one of those routes would.
//
// The policy decisions use the shared test project, whose one target is in de-DE: a click on
// "Konto löschen" (delete account) is denied as irreversible there, and "Create account" is not.
// See docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitDraft, assertBranded, defaultRedactor, failure, planHash, planStanding, policyGate, readPlanText, run, success, unverified, writePlanText,
  type BrowserDriver, type DerivedActor, type DraftError, type Plan, type PlanDraft, type PlanError, type PlanFormat, type PlanParse,
  type PlanProvenance, type PlanSource, type ProvenanceBasis,
} from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import { memoryApprovalStore, memoryEventSink, parsedSignupPlan, withRepository } from './approval-repositories.ts';
import { ORIGIN, accountClosurePlan, defaultParser, signupPlan, testProject, testProjectInput, withValue, type JsonRecord } from './plan-examples.ts';

// ---- One draft fixture per route ------------------------------------------------------------------------

type Route = { readonly format: PlanFormat; readonly basis: ProvenanceBasis; readonly reference?: string };

const ROUTES: { readonly [Source in PlanSource]: Route } = {
  'hand-written': { format: 'text', basis: 'declared' },
  'customer-llm': { format: 'json', basis: 'declared' },
  'draft-command': { format: 'text', basis: 'core-recorded', reference: 'specs/signup.md' },
  'ticket': { format: 'text', basis: 'core-recorded', reference: '42' },
  'builder': { format: 'text', basis: 'core-recorded', reference: 'builder-session-1' },
  'recorder': { format: 'text', basis: 'core-recorded', reference: 'recorder-session-1' },
  'chat': { format: 'json', basis: 'core-recorded', reference: 'conversation-7' },
};
const isSource = (key: string): key is PlanSource => Object.hasOwn(ROUTES, key);
const SOURCES: readonly PlanSource[] = Object.keys(ROUTES).filter(isSource);
// The sources a caller may declare, and the routes only core may record.
const DECLARABLE: readonly PlanSource[] = SOURCES.filter((source) => ROUTES[source].basis === 'declared');
const CORE_RECORDED: readonly PlanSource[] = SOURCES.filter((source) => ROUTES[source].basis === 'core-recorded');

// The provenance a hand-written file gets when no source is declared.
const DEFAULT_PROVENANCE: PlanProvenance = { source: 'hand-written', basis: 'declared' };

function provenanceOf(source: PlanSource): PlanProvenance {
  const route = ROUTES[source];
  return { source, basis: route.basis, ...(route.reference === undefined ? {} : { reference: route.reference }) };
}

// The one place a draft is built: `provenance` is the declared source, or none at all.
function draftWith(format: PlanFormat, content: string, provenance: PlanProvenance | undefined): PlanDraft {
  return { format, content, ...(provenance === undefined ? {} : { provenance }) };
}

// A plan's content as a route would write it: readable text as writePlanText writes it, or JSON as an agent writes it.
function contentOf(plan: JsonRecord, format: PlanFormat): string {
  const parsed = defaultParser()(plan);
  if (!parsed.ok) throw new Error(`the fixture plan was refused: ${JSON.stringify(parsed.error)}`);
  return format === 'text' ? writePlanText(parsed.value) : JSON.stringify(plan, null, 2);
}

// The draft the route for `source` would produce for `plan`.
const draftOf = (source: PlanSource, plan: JsonRecord, format: PlanFormat = ROUTES[source].format): PlanDraft =>
  draftWith(format, contentOf(plan, format), provenanceOf(source));

// The JSON the parser should receive for a draft: what the text reads to, or the JSON itself.
function expectedParserInput(draft: PlanDraft): unknown {
  if (draft.format === 'json') return JSON.parse(draft.content);
  const read = readPlanText(draft.content, testProject().limits);
  if (!read.ok) assert.fail(`the fixture text was refused: ${JSON.stringify(read.error)}`);
  return read.value.json;
}

const someActor = (): DerivedActor => unverified({ kind: 'plan', hash: planHash(parsedSignupPlan()) }, 'local');
const shown = (errors: readonly DraftError[]): string => JSON.stringify(errors);

// ---- Spies ------------------------------------------------------------------------------------------------

type CallLog = string[];

// A plan parser that logs each call, keeps what it was given and what it returned, and otherwise
// is `inner`.
function spyParser(log: CallLog, inner: PlanParse = defaultParser()) {
  const inputs: unknown[] = [];
  const plans: Plan[] = [];
  const parse: PlanParse = (input) => {
    log.push('parse');
    inputs.push(input);
    const parsed = inner(input);
    if (parsed.ok) plans.push(parsed.value);
    return parsed;
  };
  return { parse, inputs, plans };
}

// A driver that logs each call and opens no browser.
function loggingDriver(log: CallLog): BrowserDriver {
  return {
    info: { id: 'playwright', version: 'test', protocol: 'none' },
    supports() { log.push('driver'); return success(true as const); },
    async open() {
      log.push('driver');
      return failure({ reason: 'launch-failed' as const, detail: 'the logging driver opens no browser' });
    },
  };
}

// Runs an admitted plan as every run must: through the policy gate, then run().
async function runAdmitted(plan: Plan, log: CallLog): Promise<void> {
  const trusted = await trustedProjectFrom(testProjectInput());
  log.push('gate');
  const authorised = authorise(plan, trusted);
  const targetId = plan.targets[0];
  assert.ok(targetId !== undefined, 'the plan has no target');
  await run({
    plan: authorised, project: testProject(), targetId, baseUrl: ORIGIN, seed: 7, fixedTimeMilliseconds: 0,
    fixtures: [], host: { platform: 'test', arch: 'test' },
  }, {
    drivers: new Map([['playwright', loggingDriver(log)]]), clock: systemClock, artifacts: memoryArtifactStore(),
    redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
  });
}

// ---- Every route's draft is parsed first ------------------------------------------------------------------

for (const source of DECLARABLE) {
  test(`a ${source} draft is parsed exactly once, and the plan admitted is the parser's own`, { criterion: 'AC-SPEC-28-03' }, () => {
    const log: CallLog = [];
    const spy = spyParser(log);
    const admitted = admitDraft(draftOf(source, signupPlan()), spy.parse, memoryEventSink(), someActor());
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    if (!admitted.ok) return;
    assert.deepEqual(log, ['parse']);
    assert.equal(admitted.value, spy.plans[0], 'the admitted plan is not the object the parser returned');
  });

  test(`a ${source} draft reaches the parser as plain JSON, never as a Plan`, { criterion: 'AC-SPEC-28-03' }, () => {
    const spy = spyParser([]);
    const draft = draftOf(source, signupPlan());
    admitDraft(draft, spy.parse, memoryEventSink(), someActor());
    assert.equal(spy.inputs.length, 1);
    assert.throws(() => assertBranded(spy.inputs[0]), 'the parser was given something the parser had already made');
    assert.deepEqual(spy.inputs[0], expectedParserInput(draft));
  });

  test(`a ${source} draft reaches a run only after its parse: no gate or driver call comes first`, { criterion: 'AC-SPEC-28-03' }, async () => {
    const log: CallLog = [];
    const admitted = admitDraft(draftOf(source, signupPlan()), spyParser(log).parse, memoryEventSink(), someActor());
    if (!admitted.ok) assert.fail(shown(admitted.error));
    assert.deepEqual(log, ['parse'], 'something besides the parser was called while the draft was admitted');
    await runAdmitted(admitted.value, log);
    assert.equal(log[0], 'parse');
    assert.equal(log[1], 'gate');
    assert.ok(log.slice(2).includes('driver'), `the admitted plan never reached the driver: ${JSON.stringify(log)}`);
  });

  test(`a ${source} draft the parser refuses is not admitted, even when the text reads cleanly`, { criterion: 'AC-SPEC-28-03' }, () => {
    // A mutant parser that refuses everything: had admitDraft built the plan itself, it would pass.
    const refusal: readonly PlanError[] = [{ code: 'unknown_step', path: '$.steps[0]' }];
    const refusing: PlanParse = () => failure(refusal);
    const admitted = admitDraft(draftOf(source, signupPlan()), refusing, memoryEventSink(), someActor());
    assert.equal(admitted.ok, false);
    if (admitted.ok) return;
    assert.ok(admitted.error.some((error) => error.stage === 'plan' && error.code === 'unknown_step' && error.path === '$.steps[0]'), shown(admitted.error));
  });

  test(`a ${source} draft is admitted as whatever plan the parser returns`, { criterion: 'AC-SPEC-28-03' }, () => {
    // A mutant parser that answers with a different plan: the admitted plan follows the parser.
    const substitute = parsedSignupPlan(accountClosurePlan());
    const admitted = admitDraft(draftOf(source, signupPlan()), () => success(substitute), memoryEventSink(), someActor());
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    if (admitted.ok) assert.equal(admitted.value, substitute);
  });
}

for (const source of CORE_RECORDED) {
  test(`a draft claiming to come from core's ${source} route is refused before the parser, and nothing runs`, { criterion: 'AC-SPEC-28-03' }, () => {
    const log: CallLog = [];
    const admitted = admitDraft(draftOf(source, signupPlan()), spyParser(log).parse, memoryEventSink(), someActor());
    assert.equal(admitted.ok, false, `a caller's claim of the ${source} route was admitted`);
    assert.deepEqual(log, [], 'the parser, gate or driver was called for a refused claim');
  });
}

test('a text draft the reader refuses never reaches the parser', { criterion: 'AC-SPEC-28-03' }, () => {
  const log: CallLog = [];
  const admitted = admitDraft(draftWith('text', 'Teleport to "nowhere"\n', DEFAULT_PROVENANCE), spyParser(log).parse, memoryEventSink(), someActor());
  assert.equal(admitted.ok, false);
  assert.deepEqual(log, []);
});

for (const content of ['{ "version": "1.2", ', 'not JSON at all', '']) {
  test(`a JSON draft that is not JSON (${JSON.stringify(content)}) is not_object at $, before the parser`, { criterion: 'AC-SPEC-28-03' }, () => {
    const log: CallLog = [];
    const events = memoryEventSink();
    const admitted = admitDraft(draftWith('json', content, DEFAULT_PROVENANCE), spyParser(log).parse, events, someActor());
    if (admitted.ok) assert.fail('malformed JSON was admitted');
    assert.deepEqual(admitted.error.map((error) => (error.stage === 'plan' ? `${error.code} ${error.path}` : `text ${error.code}`)), ['not_object $']);
    assert.deepEqual(log, []);
    assert.deepEqual(events.recorded.map(({ event }) => event.kind), ['plan.rejected']);
  });
}

// ---- Declared sources --------------------------------------------------------------------------------------

for (const format of ['text', 'json'] as const) {
  test(`a ${format} draft with no declared source is recorded as hand-written, basis declared`, { criterion: 'AC-SPEC-28-09' }, () => {
    const events = memoryEventSink();
    const admitted = admitDraft(draftWith(format, contentOf(signupPlan(), format), undefined), defaultParser(), events, someActor());
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(events.recorded.length, 1);
    assert.deepEqual(events.recorded[0]?.event.planProvenance, DEFAULT_PROVENANCE);
  });
}

test('a draft declared as customer-llm keeps that source, basis declared', { criterion: 'AC-SPEC-28-09' }, () => {
  // The counter-example to the default: a declared source is recorded as declared, not replaced.
  const events = memoryEventSink();
  const declared: PlanProvenance = { source: 'customer-llm', basis: 'declared' };
  admitDraft(draftWith('json', contentOf(signupPlan(), 'json'), declared), defaultParser(), events, someActor());
  assert.deepEqual(events.recorded[0]?.event.planProvenance, declared);
});

for (const source of SOURCES) {
  test(`a draft claiming a core-recorded basis for ${source} is refused with untrusted-source`, { criterion: 'AC-SPEC-28-09' }, () => {
    const events = memoryEventSink();
    const claim: PlanProvenance = { source, basis: 'core-recorded' };
    const admitted = admitDraft(draftWith('text', contentOf(signupPlan(), 'text'), claim), defaultParser(), events, someActor());
    if (admitted.ok) assert.fail(`a claimed core-recorded basis for ${source} was admitted`);
    assert.ok(shown(admitted.error).includes('untrusted-source'), shown(admitted.error));
    assert.deepEqual(events.recorded.map(({ event }) => event.kind), ['plan.rejected']);
    // The counter-example: the same content, declared rather than claimed, is admitted when the source may be declared.
    if (DECLARABLE.includes(source)) {
      assert.equal(admitDraft(draftWith('text', contentOf(signupPlan(), 'text'), { source, basis: 'declared' }), defaultParser(), memoryEventSink(), someActor()).ok, true);
    }
  });
}

// ---- One audit event, with the draft's provenance ----------------------------------------------------------

for (const source of DECLARABLE) {
  test(`admitting a ${source} draft appends one plan.submitted event with its source and basis`, { criterion: 'AC-SPEC-28-08' }, () => {
    const events = memoryEventSink();
    const actor = someActor();
    const admitted = admitDraft(draftOf(source, signupPlan()), defaultParser(), events, actor);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(events.recorded.length, 1, JSON.stringify(events.recorded));
    const recorded = events.recorded[0];
    assert.equal(recorded?.event.kind, 'plan.submitted');
    assert.deepEqual(recorded?.event.planProvenance, provenanceOf(source));
    // The source is recorded, never trusted: the actor is the one core derived, whatever the source says.
    assert.equal(recorded?.actor, actor);
  });

  for (const format of ['text', 'json'] as const) {
    test(`refusing a ${source} draft in ${format} form appends one plan.rejected event with its source and basis`, { criterion: 'AC-SPEC-28-08' }, () => {
      const events = memoryEventSink();
      const content = format === 'text'
        ? 'Teleport to "nowhere"\n'
        : JSON.stringify({ ...signupPlan(), steps: [{ type: 'teleport', to: 'nowhere' }] });
      const admitted = admitDraft(draftWith(format, content, provenanceOf(source)), defaultParser(), events, someActor());
      assert.equal(admitted.ok, false);
      assert.deepEqual(events.recorded.map(({ event }) => event.kind), ['plan.rejected']);
      assert.deepEqual(events.recorded[0]?.event.planProvenance, provenanceOf(source));
    });
  }
}

// What a plan's route could change, if the source were trusted: its hash, the policy gate's
// decision, and whether it stands approved or as a proposal.
async function treatmentOf(draft: PlanDraft): Promise<string> {
  const admitted = admitDraft(draft, defaultParser(), memoryEventSink(), someActor());
  if (!admitted.ok) assert.fail(shown(admitted.error));
  const project = testProject();
  const decision = policyGate({ project, events: memoryEventSink() }).decide(admitted.value, project.matrix);
  let approvedStanding = '';
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    if (!verified.ok) throw new Error(`the sign-up plan was not approved: ${verified.error}`);
    approvedStanding = planStanding(admitted.value, memoryApprovalStore([verified.value.approval])).mode;
  });
  return JSON.stringify({
    hash: planHash(admitted.value),
    decision: decision.kind === 'deny' ? `deny ${decision.rule} at ${String(decision.stepIndex)}` : 'allow',
    withoutApproval: planStanding(admitted.value, memoryApprovalStore([])).mode,
    withTheSignUpApproval: approvedStanding,
  });
}

const DENIED_SIGNUP = (): JsonRecord => withValue(signupPlan(), ['steps', 8, 'locator', 'name'], 'Konto löschen');

for (const { name, plan, decision, approved } of [
  { name: 'the sign-up plan', plan: signupPlan, decision: 'allow', approved: 'approved' },
  { name: 'the sign-up plan with an irreversible click', plan: DENIED_SIGNUP, decision: 'deny irreversible-action at 8', approved: 'proposal' },
]) {
  test(`${name} gets the same hash, policy decision and approval requirement from every admissible source and form`, { criterion: 'AC-SPEC-28-08' }, async () => {
    const drafts: { readonly label: string; readonly draft: PlanDraft }[] = [
      ...DECLARABLE.flatMap((source) => (['text', 'json'] as const).map((format) => ({ label: `${source} ${format}`, draft: draftOf(source, plan(), format) }))),
      ...(['text', 'json'] as const).map((format) => ({ label: `no declared source, ${format}`, draft: draftWith(format, contentOf(plan(), format), undefined) })),
    ];
    const treatments: { label: string; treatment: string }[] = [];
    for (const { label, draft } of drafts) treatments.push({ label, treatment: await treatmentOf(draft) });
    const first = treatments[0]?.treatment;
    // The expected treatment, so a test that compared nothing with nothing would fail.
    assert.ok(first !== undefined);
    assert.equal(JSON.parse(first).decision, decision);
    assert.equal(JSON.parse(first).withoutApproval, 'proposal');
    assert.equal(JSON.parse(first).withTheSignUpApproval, approved);
    for (const { label, treatment } of treatments) assert.equal(treatment, first, `${label} was treated differently`);
  });
}
