import type { StepCode } from "../foundation/StepCode.ts";
import type { StepOutcome } from "../foundation/StepOutcome.ts";
import type { CallName, ServiceCallErrorCode } from "../plan/steps/ServiceCaller.ts";
import type { CommandName } from "../plan/steps/UnsafeFeaturesDeclaration.ts";

// What a cleanup step ran: one of the plan's declared calls, or one of its database commands.
export type CleanupSubject = { readonly call: CallName } | { readonly command: CommandName };

// A cleanup step's record, numbered from 0 among the cleanup steps. A failed one is always
// cleanup-failed, and its cause is the code its call or command failed with; no other holds either.
// A skipped one named a run value that no step remembered.
export type CleanupResult = CleanupSubject & { readonly index: number } & (
        | {
              readonly outcome: typeof StepOutcome.Passed;
              readonly code?: never;
              readonly cause?: never;
          }
        | {
              readonly outcome: typeof StepOutcome.Failed;
              readonly code: typeof ServiceCallErrorCode.CleanupFailed;
              readonly cause: StepCode;
          }
        | {
              readonly outcome: typeof StepOutcome.Skipped;
              readonly code?: never;
              readonly cause?: never;
          }
    );
