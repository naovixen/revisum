import { PageReadFailureCode, type DocumentSession } from "@revisum/engine";

// Whether a dialog holds the document, as a read of its page says.
export async function isHeldByADialog(document: Pick<DocumentSession, "page">): Promise<boolean> {
    const read = await document.page();
    return !read.ok && read.error.code === PageReadFailureCode.DialogOpen;
}
