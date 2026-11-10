// A thrown value as an Error, for code that reports what a port threw and goes on.
export const asError = (thrown: unknown, context: string): Error =>
    thrown instanceof Error ? thrown : new Error(`${context}: ${String(thrown)}`);
