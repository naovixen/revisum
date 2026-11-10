export interface CleanUpScope {
    // Registers a clean-up straight after its resource has started, so a resource that never started is never closed.
    add(cleanUp: () => unknown): void;
    // Runs every clean-up once, last registered first, and throws one AggregateError naming each that failed.
    runAll(): Promise<void>;
}

export function createCleanUpScope(): CleanUpScope {
    const cleanUps: Array<() => unknown> = [];
    return {
        add(cleanUp) {
            cleanUps.push(cleanUp);
        },
        async runAll() {
            const failures: unknown[] = [];
            for (const cleanUp of cleanUps.splice(0).reverse()) {
                try {
                    await cleanUp();
                } catch (failure) {
                    failures.push(failure);
                }
            }
            if (failures.length > 0) {
                throw new AggregateError(failures, `${failures.length} clean-up(s) failed`);
            }
        },
    };
}
