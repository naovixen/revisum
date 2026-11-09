import {
    PageAssertionKind,
    StepCode,
    stepFailed,
    StepOutcome,
    type PageAssertion,
    type Result,
    type StepByType,
} from "@revisum/contracts";
import { checkPage as judgePage } from "../../outcome/Verdict.ts";
import { resolveText } from "../../values/RunValues.ts";
import { SECRET_PLACEHOLDER } from "../../../secrets/SecretRedaction.ts";
import { isCheckStopped, poll, verdictOfFailedRead } from "../../Poll.ts";
import type { RunContext } from "../../RunContext.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";

// A page check with a meta tag's expected content resolved, when it is a value reference.
function resolvePageAssertion(
    assertion: PageAssertion,
    context: Pick<RunContext, "values" | "cleared">,
): Result<PageAssertion, StepCode> {
    if (assertion.kind !== PageAssertionKind.MetaContent) {
        return { ok: true, value: assertion };
    }
    const expected = resolveText(
        assertion.value,
        context.values,
        context.cleared.project.limits.maximumTextLength,
    );
    return expected.ok ? { ok: true, value: { ...assertion, value: expected.value } } : expected;
}

// Waits until the page passes the check, or the step timeout runs out. A failed check keeps the
// page's title, redacted.
export const checkPage: StepExecutor<
    StepByType["expectPage"],
    StepNeeds<
        | "values"
        | "cleared"
        | "document"
        | "inputs"
        | "ports"
        | "logger"
        | "isShortSecret"
        | "redactor"
    >
> = async (step, context) => {
    const assertion = resolvePageAssertion(step.assert, context);
    if (!assertion.ok) {
        return stepFailed(assertion.error);
    }
    const seen = { title: "" };
    const verdict = await poll(context, context.document, async () => {
        const page = await context.document.page();
        if (!page.ok) {
            return verdictOfFailedRead(page.error, context.logger);
        }
        seen.title = page.value.title;
        return judgePage(assertion.value, page.value, context.inputs.baseUrl);
    });
    if (isCheckStopped(verdict)) {
        return stepFailed(verdict.code);
    }
    if (verdict.pass) {
        return { outcome: StepOutcome.Passed };
    }
    const observed = context.isShortSecret(seen.title)
        ? SECRET_PLACEHOLDER
        : context.redactor.text(seen.title);
    return { ...stepFailed(verdict.code), observed };
};
