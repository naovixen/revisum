// What a thrown value says, short enough to keep in a step's detail.
export const errorText = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).slice(0, 200);
