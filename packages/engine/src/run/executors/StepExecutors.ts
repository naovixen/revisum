// How the run carries out each step type: one executor per type, grouped as the plan language's
// sections are.
import type { StepType } from "@revisum/contracts";
import type { RunStepByType } from "../../RunStep.ts";
import { actOnElement } from "./actions/ActOnElement.ts";
import { answerDialog } from "./actions/AnswerDialog.ts";
import { fillField } from "./actions/FillField.ts";
import { CLOCK_AND_CLIPBOARD_EXECUTORS } from "./clock-and-clipboard/ClockAndClipboardExecutors.ts";
import { DATABASE_COMMAND_EXECUTORS } from "./database-commands/DatabaseCommandExecutors.ts";
import { checkDownload } from "./downloads/CheckDownload.ts";
import { downloadFile } from "./downloads/DownloadFile.ts";
import { auditAccessibility } from "./evidence/AuditAccessibility.ts";
import { capture } from "./evidence/Capture.ts";
import { enterFrame } from "./frames-and-tabs/EnterFrame.ts";
import { openNewTab } from "./frames-and-tabs/OpenNewTab.ts";
import { navigate } from "./navigation/Navigate.ts";
import { NETWORK_AND_STORAGE_EXECUTORS } from "./network-and-storage/NetworkAndStorageExecutors.ts";
import { PAGE_SCRIPT_EXECUTORS } from "./page-scripts/PageScriptExecutors.ts";
import { checkElement } from "./page-checks/CheckElement.ts";
import { checkPage } from "./page-checks/CheckPage.ts";
import { remember } from "./page-checks/Remember.ts";
import { SERVICE_CALL_EXECUTORS } from "./service-calls/ServiceCallExecutors.ts";
import type { StepContext, StepExecutorTable, StepRecord } from "./StepExecutor.ts";

export const STEP_EXECUTORS: StepExecutorTable = {
    navigate,
    click: actOnElement,
    hover: actOnElement,
    fill: fillField,
    select: actOnElement,
    upload: actOnElement,
    press: actOnElement,
    frame: enterFrame,
    dialog: answerDialog,
    expect: checkElement,
    expectPage: checkPage,
    a11yAudit: auditAccessibility,
    capture,
    remember,
    download: downloadFile,
    expectDownload: checkDownload,
    newTab: openNewTab,
    ...SERVICE_CALL_EXECUTORS,
    ...NETWORK_AND_STORAGE_EXECUTORS,
    ...CLOCK_AND_CLIPBOARD_EXECUTORS,
    ...PAGE_SCRIPT_EXECUTORS,
    ...DATABASE_COMMAND_EXECUTORS,
};

// Runs one step with its type's executor.
export const executeStep = async <Type extends StepType>(
    type: Type,
    step: RunStepByType[Type],
    context: StepContext,
): Promise<StepRecord> => await STEP_EXECUTORS[type](step, context);
