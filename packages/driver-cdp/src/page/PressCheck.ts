// What a press's check gives the session that sends the press.
import type { PageFunction } from "./PageFunction.ts";

// How far a press was sent before anything stopped it. A dialog holds the release back.
export const PressSent = {
    NotSent: "not-sent",
    HeldAtThePress: "held-at-the-press",
    Released: "released",
} as const;
export type PressSent = (typeof PressSent)[keyof typeof PressSent];

// What a read of a press's check gave.
export type CheckRead =
    | { readonly kind: "answered"; readonly value: unknown }
    // The check's document has gone: replaced, closed or removed.
    | { readonly kind: "document-gone" }
    | { readonly kind: "held-by-dialog" }
    | { readonly kind: "failed"; readonly detail: string };

// A check armed for one press, for as long as withPressCheck runs what it is given.
export type PressCheck = {
    // Runs an in-page function with the armed check as `this`.
    read(pageFunction: PageFunction): Promise<CheckRead>;
    // What the check reported before now.
    reports(): Promise<ReadonlySet<string>>;
};
