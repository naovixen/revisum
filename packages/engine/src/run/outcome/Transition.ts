// The run lifecycle as a typed state machine. Each transition function accepts only the state it
// is legal from, so an illegal transition does not compile.
//
//   Planned ──► Resolved ──► Running ──► Passed | Failed | Errored | Denied
//      ├──► TargetUnavailable   (explicit; the engine never substitutes a target)
//      ├──► Refused             (production it may not reach, a secret the store lacks, or something the plan needs
//      │                         that this run can't do; no driver is called and no call is made)
//      └──► Errored             (a driver that broke its promise of a Result as the session opened)
//
// A plan reaches Planned only once the policy gate has authorised it. Denied is the run the gate's
// runtime guard stopped before an action; the denied action sent no input event.
import type {
  Denial, Plan, PlanRefusal, PlanRunManifest, Session, Target, TerminalState as EndState, Unavailable,
} from '@revisum/contracts';

type Transitions = {
  readonly Planned: 'Resolved' | 'TargetUnavailable' | 'Refused' | 'Errored';
  readonly Resolved: 'Running';
  readonly Running: 'Passed' | 'Failed' | 'Errored' | 'Denied';
  readonly Passed: never;
  readonly Failed: never;
  readonly Errored: never;
  readonly TargetUnavailable: never;
  readonly Refused: never;
  readonly Denied: never;
};
type RunState = keyof Transitions;
type TerminalState = { [State in RunState]: Transitions[State] extends never ? State : never }[RunState];
// The states with no way out are exactly the states a result can end in, so a state added to either fails to compile.
type EndStatesMatch<Check extends true> = Check;
export type TerminalStatesMatchTheResult = EndStatesMatch<[TerminalState] extends [EndState] ? ([EndState] extends [TerminalState] ? true : false) : false>;

// A type-level guard for logging state changes: only legal (from, to) pairs compile.
export const transition = <From extends RunState, To extends Transitions[From]>(from: From, to: To): { readonly from: From; readonly to: To } => ({ from, to });

export type Planned = { readonly state: 'Planned'; readonly plan: Plan; readonly target: Target };
export type Resolved = Omit<Planned, 'state'> & {
  readonly state: 'Resolved'; readonly session: Session; readonly manifest: PlanRunManifest; readonly manifestHash: string;
};
export type Running = Omit<Resolved, 'state'> & { readonly state: 'Running' };
export type Finished<State extends 'Passed' | 'Failed' | 'Errored'> = Omit<Running, 'state' | 'session'> & { readonly state: State };
type TargetUnavailableRun = Omit<Planned, 'state'> & { readonly state: 'TargetUnavailable'; readonly unavailable: Unavailable };

type RefusedRun = Omit<Planned, 'state'> & { readonly state: 'Refused'; readonly refusal: PlanRefusal };

export type DeniedRun = Omit<Running, 'state' | 'session'> & { readonly state: 'Denied'; readonly denial: Denial };

export const plan = (approved: Plan, target: Target): Planned => ({ state: 'Planned', plan: approved, target });

export const resolve = (run: Planned, session: Session, manifest: PlanRunManifest, manifestHash: string): Resolved =>
  ({ ...run, state: 'Resolved', session, manifest, manifestHash });

export const targetUnavailable = (run: Planned, unavailable: Unavailable): TargetUnavailableRun =>
  ({ ...run, state: 'TargetUnavailable', unavailable });

export const refuse = (run: Planned, refusal: PlanRefusal): RefusedRun => ({ ...run, state: 'Refused', refusal });

export const start = (run: Resolved): Running => ({ ...run, state: 'Running' });

export function finish<State extends Exclude<Transitions['Running'], 'Denied'>>(run: Running, state: State): Finished<State> {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state };
}

export function deny(run: Running, denial: Denial): DeniedRun {
  const { session: _closedSeparately, ...rest } = run;
  return { ...rest, state: 'Denied', denial };
}

