// The run lifecycle as a typed state machine. Each transition function accepts only the state it
// is legal from, so an illegal transition does not compile.
//
//   Planned ──► Resolved ──► Running ──► Passed | Failed | Errored | Denied
//      │            └──────────────────► Errored
//      ├──► TargetUnavailable   (explicit; the engine never substitutes a target)
//      └──► Refused             (a plan not allowed on production that would reach it; no driver is called)
//
// A plan reaches Planned only once the policy gate has authorised it. Denied is the run the gate's
// runtime guard stopped before an action; the denied action sent no input event.
import type { Plan, PolicyRuleId, Session, Target, Unavailable } from '@revisum/contracts';
import type { RunManifest } from './manifest.ts';

export type Transitions = {
  readonly Planned: 'Resolved' | 'TargetUnavailable' | 'Refused';
  readonly Resolved: 'Running' | 'Errored';
  readonly Running: 'Passed' | 'Failed' | 'Errored' | 'Denied';
  readonly Passed: never;
  readonly Failed: never;
  readonly Errored: never;
  readonly TargetUnavailable: never;
  readonly Refused: never;
  readonly Denied: never;
};
export type RunState = keyof Transitions;
export type TerminalState = { [State in RunState]: Transitions[State] extends never ? State : never }[RunState];

// A type-level guard for logging state changes: only legal (from, to) pairs compile.
export const transition = <From extends RunState, To extends Transitions[From]>(from: From, to: To): { readonly from: From; readonly to: To } => ({ from, to });

export type Planned = { readonly state: 'Planned'; readonly plan: Plan; readonly target: Target };
export type Resolved = Omit<Planned, 'state'> & {
  readonly state: 'Resolved'; readonly session: Session; readonly manifest: RunManifest; readonly manifestHash: string;
};
export type Running = Omit<Resolved, 'state'> & { readonly state: 'Running' };
export type Finished<State extends 'Passed' | 'Failed' | 'Errored'> = Omit<Running, 'state' | 'session'> & { readonly state: State };
export type TargetUnavailableRun = Omit<Planned, 'state'> & { readonly state: 'TargetUnavailable'; readonly unavailable: Unavailable };

// Why a run was refused before any driver call. origin_not_allowed: the run would reach one of the
// project's production origins, which only an approved plan may reach, and only when the project
// allows production for approved plans.
export type Refusal = { readonly code: 'origin_not_allowed'; readonly origin: string };
export type RefusedRun = Omit<Planned, 'state'> & { readonly state: 'Refused'; readonly refusal: Refusal };

// Which policy rule stopped the run, and at which step.
export type Denial = { readonly rule: PolicyRuleId; readonly stepIndex: number };
export type DeniedRun = Omit<Running, 'state' | 'session'> & { readonly state: 'Denied'; readonly denial: Denial };

export const plan = (approved: Plan, target: Target): Planned => ({ state: 'Planned', plan: approved, target });

export const resolve = (run: Planned, session: Session, manifest: RunManifest, manifestHash: string): Resolved =>
  ({ ...run, state: 'Resolved', session, manifest, manifestHash });

export const targetUnavailable = (run: Planned, unavailable: Unavailable): TargetUnavailableRun =>
  ({ ...run, state: 'TargetUnavailable', unavailable });

export const refuse = (run: Planned, refusal: Refusal): RefusedRun => ({ ...run, state: 'Refused', refusal });

export const start = (run: Resolved): Running => ({ ...run, state: 'Running' });

export function finish<State extends Exclude<Transitions['Running'], 'Denied'>>(run: Running, state: State): Finished<State> {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state };
}

export function deny(run: Running, denial: Denial): DeniedRun {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state: 'Denied', denial };
}

// Resolved can only end as Errored without running, for example when setup failed.
export function abort(run: Resolved): Finished<'Errored'> {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state: 'Errored' };
}
