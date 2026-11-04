// What every fake keeps of how it was used, so a test can read a port's calls instead of counting
// them by hand.
export type RecordedCall = {
    readonly method: string;
    readonly arguments: readonly unknown[];
};

export type RecordedCalls = {
    all(): readonly RecordedCall[];
    to(method: string): readonly RecordedCall[];
    // How many calls were made to `method`, or to any method when none is named.
    count(method?: string): number;
};

export type Recorded<Port> = Port & { readonly calls: RecordedCalls };

function recordedCalls(log: readonly RecordedCall[]): RecordedCalls {
    const to = (method: string): readonly RecordedCall[] =>
        log.filter((call) => call.method === method);
    return {
        all: () => [...log],
        to,
        count: (method) => (method === undefined ? log.length : to(method).length),
    };
}

// The port as given, but noting every call made to any of its methods before answering it, whether
// the method is the fake's default or a test's override.
export function recordCalls<Port extends object>(port: Port): Recorded<Port> {
    const log: { method: string; arguments: readonly unknown[] }[] = [];
    return new Proxy(
        { ...port, calls: recordedCalls(log) },
        {
            get(target, member) {
                const value: unknown = Reflect.get(target, member);
                if (typeof value !== "function") {
                    return value;
                }
                return (...given: unknown[]): unknown => {
                    log.push({ method: String(member), arguments: given });
                    return Reflect.apply(value, target, given);
                };
            },
        },
    );
}
