class FieldHolder {
    constructor(fields: object) {
        Object.assign(this, fields);
    }
}

// A class instance whose own fields are exactly the given ones, so only its prototype tells it from
// what JSON writes: a guard that looks at no more than the keys accepts it.
export const classInstanceHolding = (fields: object): object => new FieldHolder(fields);
