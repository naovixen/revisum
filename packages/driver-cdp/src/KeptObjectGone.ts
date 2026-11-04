// What a call on a kept object fails with when the object no longer exists: its document was replaced
// or closed, or its handle was released.
export class KeptObjectGone extends Error {
    constructor() {
        super("the object the driver kept has gone");
        this.name = "KeptObjectGone";
    }
}
