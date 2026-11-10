// A complete fake has every optional member of its port. A test about a port that lacks one says so
// by name, because absent and harmless are different things to a run.
export type OptionalMember<Port> = {
    [Member in keyof Port]-?: object extends Pick<Port, Member> ? Member : never;
}[keyof Port];

export function leaveOut<Port extends object>(
    port: Port,
    members: readonly OptionalMember<Port>[],
): Port {
    const kept = { ...port };
    for (const member of members) {
        Reflect.deleteProperty(kept, String(member));
    }
    return kept;
}
