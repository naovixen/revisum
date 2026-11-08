// The rules pageAudit (PageAudit.ts) checks, by id, with the W3C ACT rule each follows where one
// exists, its WCAG success criteria and its impact. pageAudit is given this table, and the audit
// reader accepts only its ids, so the two cannot drift apart.
import { Impact } from "@revisum/contracts";

export type PageAuditRule = {
    readonly actRule: string | null;
    readonly wcag: readonly string[];
    readonly impact: Impact;
};

export const PAGE_AUDIT_RULES: Readonly<Record<string, PageAuditRule>> = {
    "image-alt": { actRule: "23a2a8", wcag: ["1.1.1"], impact: Impact.Critical },
    "button-name": { actRule: "97a4e1", wcag: ["4.1.2"], impact: Impact.Critical },
    "link-name": { actRule: "c487ae", wcag: ["2.4.4", "4.1.2"], impact: Impact.Serious },
    "label": { actRule: "e086e5", wcag: ["4.1.2", "1.3.1"], impact: Impact.Critical },
    "document-title": { actRule: "2779a5", wcag: ["2.4.2"], impact: Impact.Serious },
    "html-has-lang": { actRule: "b5c3f8", wcag: ["3.1.1"], impact: Impact.Serious },
    "html-lang-valid": { actRule: "bf051a", wcag: ["3.1.1"], impact: Impact.Serious },
    "valid-lang": { actRule: "de46e4", wcag: ["3.1.2"], impact: Impact.Serious },
    "list": { actRule: null, wcag: ["1.3.1"], impact: Impact.Serious },
    "autocomplete-valid": { actRule: "73f2c2", wcag: ["1.3.5"], impact: Impact.Serious },
    "color-contrast": { actRule: "afw4f7", wcag: ["1.4.3"], impact: Impact.Serious },
    "meta-viewport": { actRule: "b4f0c3", wcag: ["1.4.4"], impact: Impact.Critical },
    "meta-refresh": { actRule: "bc659a", wcag: ["2.2.1"], impact: Impact.Critical },
    "marquee": { actRule: null, wcag: ["2.2.2"], impact: Impact.Serious },
    "aria-roles": { actRule: "674b10", wcag: ["4.1.2"], impact: Impact.Critical },
};
