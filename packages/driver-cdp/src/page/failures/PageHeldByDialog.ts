// What a command to a page fails with when a dialog holds the page. While a dialog is open the page
// runs no script and the browser answers no command that needs it, so waiting says nothing.
export class PageHeldByDialog extends Error {
    constructor(method: string) {
        super(`${method}: a dialog holds the page`);
        this.name = "PageHeldByDialog";
    }
}
