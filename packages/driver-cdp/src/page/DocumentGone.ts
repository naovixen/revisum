// What a command to a page fails with when the document it was about has gone: replaced, closed or
// removed. Nothing can be read of it any more, which says nothing of what was in it.
export class DocumentGone extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DocumentGone";
    }
}
