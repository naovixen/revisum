import {
    DownloadAssertionKind,
    StepCode,
    stepFailed,
    StepOutcome,
    type DownloadedFile,
    type DownloadTextKind,
    type StepByType,
    type StepRecord,
    type TextOrValue,
} from "@revisum/contracts";
import { resolveText } from "../../../run-values.ts";
import type { RunContext } from "../../RunContext.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";

const verdict = (isPassing: boolean): StepRecord =>
    isPassing ? { outcome: StepOutcome.Passed } : stepFailed(StepCode.AssertionFailed);

// A media type's essence, such as "text/csv" for "text/csv; charset=utf-8", in lower case.
const mediaTypeEssence = (mediaType: string): string =>
    (mediaType.split(";")[0] ?? "").trim().toLowerCase();

// The file's bytes as text, or undefined when they are not UTF-8 text: invalid UTF-8, or a NUL
// byte, which no text file holds.
function downloadText(bytes: Uint8Array): string | undefined {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return text.includes("\u0000") ? undefined : text;
    } catch {
        return undefined;
    }
}

// A check of the file's name or its text.
function checkText(
    file: DownloadedFile,
    assertion: { readonly kind: DownloadTextKind; readonly value: TextOrValue },
    context: Pick<RunContext, "values" | "cleared">,
): StepRecord {
    const expected = resolveText(
        assertion.value,
        context.values,
        context.cleared.project.limits.maximumTextLength,
    );
    if (!expected.ok) {
        return stepFailed(expected.error);
    }
    if (assertion.kind === DownloadAssertionKind.FileNameEquals) {
        return verdict(file.fileName === expected.value);
    }
    const text = downloadText(file.bytes);
    if (text === undefined) {
        return stepFailed(StepCode.DownloadNotText);
    }
    // An empty file proves nothing about what it holds or leaves out, so it fails both.
    if (text === "") {
        return verdict(false);
    }
    const isContained = text.includes(expected.value);
    return verdict(
        assertion.kind === DownloadAssertionKind.ContentContains ? isContained : !isContained,
    );
}

// Checks a file an earlier download step saved. None of its text is ever kept: a failed check
// keeps only its code.
export const checkDownload: StepExecutor<
    StepByType["expectDownload"],
    StepNeeds<"downloads" | "values" | "cleared">
> = (step, context) => {
    // A run has the file: the parser rejects a check of a download no earlier step defined, and a
    // failed download skips every later step. A context without it, as a caller may build, fails the
    // check as no download.
    const file = context.downloads.get(step.download);
    if (file === undefined) {
        return stepFailed(StepCode.NoDownload);
    }
    const assertion = step.assert;
    switch (assertion.kind) {
        case DownloadAssertionKind.SizeAtMost:
            return verdict(file.bytes.length <= assertion.value);
        case DownloadAssertionKind.SizeAtLeast:
            return verdict(file.bytes.length >= assertion.value);
        case DownloadAssertionKind.MediaTypeEquals:
            return verdict(mediaTypeEssence(file.mediaType) === mediaTypeEssence(assertion.value));
        case DownloadAssertionKind.FileNameEquals:
        case DownloadAssertionKind.ContentContains:
        case DownloadAssertionKind.ContentExcludes:
            return checkText(file, assertion, context);
    }
};
