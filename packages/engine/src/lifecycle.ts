// The run lifecycle as a typed state machine. Each transition function accepts only the state it
// is legal from, so an illegal transition does not compile.
//
//   Planned ──► Resolved ──► Running ──► Passed | Failed | Errored
//      │            └──────────────────► Errored
//      └──► TargetUnavailable   (explicit; the engine never substitutes a target)
import type { Plan, Session, Target, Unavailable } from '@revisum/contracts';
import type { RunManifest } from './manifest.ts';

export type Transitions = {
  readonly Planned: 'Resolved' | 'TargetUnavailable';
  readonly Resolved: 'Running' | 'Errored';
  readonly Running: 'Passed' | 'Failed' | 'Errored';
  readonly Passed: never;
  readonly Failed: never;
  readonly Errored: never;
  readonly TargetUnavailable: never;
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

export const plan = (approved: Plan, target: Target): Planned => ({ state: 'Planned', plan: approved, target });

export const resolve = (run: Planned, session: Session, manifest: RunManifest, manifestHash: string): Resolved =>
  ({ ...run, state: 'Resolved', session, manifest, manifestHash });

export const targetUnavailable = (run: Planned, unavailable: Unavailable): TargetUnavailableRun =>
  ({ ...run, state: 'TargetUnavailable', unavailable });

export const start = (run: Resolved): Running => ({ ...run, state: 'Running' });

export function finish<State extends Transitions['Running']>(run: Running, state: State): Finished<State> {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state };
}

// Resolved can only end as Errored without running, for example when setup failed.
export function abort(run: Resolved): Finished<'Errored'> {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state: 'Errored' };
}
