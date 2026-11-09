// Values a decoder's unknown input can be in memory, though JSON.parse never makes one: a field
// whose getter throws, a proxy whose every trap throws, a revoked proxy, and a list with no prototype.

const READ_FAILED = "reading this value is refused";

const throwOnRead = (): never => {
    throw new Error(READ_FAILED);
};

// A copy of `fields` whose field `key` is a getter that throws.
export const withThrowingGetter = (fields: object, key: string): object =>
    Object.defineProperty({ ...fields }, key, { enumerable: true, get: throwOnRead });

// A list whose first item is read through a getter that throws.
export const listWithThrowingFirstItem = (items: readonly unknown[]): object =>
    Object.defineProperty([...items], 0, { enumerable: true, get: throwOnRead });

// A proxy over `target` whose every trap throws, so even asking its prototype fails.
export const proxyThatThrows = (target: object): unknown =>
    new Proxy(target, {
        apply: throwOnRead,
        construct: throwOnRead,
        defineProperty: throwOnRead,
        deleteProperty: throwOnRead,
        get: throwOnRead,
        getOwnPropertyDescriptor: throwOnRead,
        getPrototypeOf: throwOnRead,
        has: throwOnRead,
        isExtensible: throwOnRead,
        ownKeys: throwOnRead,
        preventExtensions: throwOnRead,
        set: throwOnRead,
        setPrototypeOf: throwOnRead,
    });

// A proxy over `target` that has been revoked, so any operation on it throws, even Array.isArray.
export const revokedProxy = (target: object): unknown => {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
};

// The same items in a list that has no prototype, so it has no map, entries or iterator.
export const listWithoutPrototype = (items: readonly unknown[]): unknown =>
    Object.setPrototypeOf([...items], null);
