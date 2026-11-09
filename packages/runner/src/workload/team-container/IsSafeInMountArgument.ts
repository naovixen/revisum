// What a host path may hold in a Docker --mount argument: a comma, quote or equals sign would break
// the argument or extend it with options of its own, as a control character could.
export function isSafeInMountArgument(path: string): boolean {
    return ![...path].some(
        (character) =>
            character === "," ||
            character === '"' ||
            character === "=" ||
            character.charCodeAt(0) < 0x20,
    );
}
