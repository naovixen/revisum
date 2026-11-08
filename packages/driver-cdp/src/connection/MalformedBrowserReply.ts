// What a command or an event fails with when the browser sends something of the wrong shape. It says
// where in the message and never what was there, which is page data and may hold secrets.
export class MalformedBrowserReply extends Error {
    constructor(method: string, path: string) {
        super(`${method}: what the browser sent is malformed at ${path}`);
        this.name = "MalformedBrowserReply";
    }
}
