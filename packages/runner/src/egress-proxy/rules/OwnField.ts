// A field of something parsed from outside the program, read only if the object itself holds it, so a
// prototype can't supply one.
export const ownField = (value: unknown, name: string): unknown =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.getOwnPropertyDescriptor(value, name)?.value
        : undefined;
