// Reads of one document as a whole: its address and head, its links and its accessibility audit.
import {
    failure,
    PageReadFailureCode,
    success,
    type A11yFinding,
    type PageMetaTag,
    type PageProbe,
    type PageReadFailure,
    type Result,
} from "@revisum/contracts";
import { PAGE_AUDIT_RULES } from "../capabilities/PageAuditRules.ts";
import { parseAudit, toFindings } from "../capabilities/ParseAudit.ts";
import { pageAudit } from "../in-page/PageAudit.ts";
import { linkTargetList, pageInfo } from "../in-page/PageInfo.ts";
import { readOfPage, type DocumentScope } from "./DocumentScope.ts";
import { answeredWithin } from "./ForAtMost.ts";
import { BROWSER_ERROR_PAGE } from "./ProbeDocument.ts";
import { fieldsOf } from "./ReportedFields.ts";

// What pageAudit is given: its rules' details, as JSON, the one form a page function's input takes.
const PAGE_AUDIT_RULE_TABLE = JSON.stringify(PAGE_AUDIT_RULES);

// Decodes what pageInfo (in-page/PageInfo.ts) reports. The page's own scripts may have changed what
// the browser hands back, so every field is checked; a meta tag of another shape is left out.
function decodePageInfo(text: string): PageProbe {
    const { url, title, meta, canonicalUrl } = fieldsOf(JSON.parse(text));
    if (typeof url !== "string" || typeof title !== "string") {
        throw new Error("the page did not report its URL and title");
    }
    const tags: PageMetaTag[] = [];
    for (const tag of Array.isArray(meta) ? meta : []) {
        const { name, content } = fieldsOf(tag);
        if (typeof name === "string" && typeof content === "string") {
            tags.push({ name, content });
        }
    }
    return {
        url,
        title,
        meta: tags,
        canonicalUrl: typeof canonicalUrl === "string" ? canonicalUrl : null,
    };
}

// Decodes what linkTargetList reports. The page's own scripts may have changed what the browser
// hands back, so an entry that is not text is left out.
function decodeLinkTargets(text: string): readonly string[] {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
        ? parsed.filter((target): target is string => typeof target === "string")
        : [];
}

export const readPage = <Handle>(
    scope: DocumentScope<Handle>,
): Promise<Result<PageProbe, PageReadFailure>> =>
    readOfPage(scope, async (): Promise<PageProbe> => {
        const shown = decodePageInfo(
            await answeredWithin(scope.timeout, scope.operations.callForString(pageInfo, [])),
        );
        // In place of a page it could not show, the browser shows its own error page at an internal
        // URL. The address bar still shows the URL it wanted, which is not a page that loaded.
        if (!shown.url.startsWith(BROWSER_ERROR_PAGE)) {
            return shown;
        }
        const unreachable = await scope.operations.unreachableUrl();
        return { ...shown, url: unreachable ?? shown.url, browserErrorPage: true };
    });

export const readLinkTargets = <Handle>(
    scope: DocumentScope<Handle>,
): Promise<Result<readonly string[], PageReadFailure>> =>
    readOfPage(scope, async () =>
        decodeLinkTargets(await scope.operations.callForString(linkTargetList, [])),
    );

export async function auditPage<Handle>(
    scope: DocumentScope<Handle>,
): Promise<Result<readonly A11yFinding[], PageReadFailure>> {
    const report = await readOfPage(scope, () =>
        answeredWithin(
            scope.timeout,
            scope.operations.callForString(pageAudit, [PAGE_AUDIT_RULE_TABLE]),
        ),
    );
    if (!report.ok) {
        return report;
    }
    const rules = parseAudit(report.value);
    return rules.ok
        ? success(toFindings(rules.value))
        : failure({
              code: PageReadFailureCode.PageUnreadable,
              detail: `the audit report is unreadable: ${rules.error.code} at ${rules.error.path}`,
          });
}
