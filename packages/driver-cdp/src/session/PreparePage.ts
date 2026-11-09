// Makes a page of the session hermetic and repeatable before it loads anything, and decides on every
// request it sends.
import { deviceProfile, determinismScript } from "@revisum/contracts";
import type { BrowserNetwork } from "../capabilities/BrowserNetwork.ts";
import {
    ADD_BINDING,
    ADD_SCRIPT_ON_NEW_DOCUMENT,
    ENABLE_RUNTIME,
    SET_DEVICE_METRICS,
    SET_EMULATED_MEDIA,
    SET_FOCUS_EMULATION,
    SET_LOCALE,
    SET_TIME_ZONE,
    SET_TOUCH_EMULATION,
    SET_USER_AGENT,
} from "../connection/BrowserCommand.ts";
import type { RequestAtResponseStage, RequestPaused } from "../connection/BrowserEvent.ts";
import {
    CONTINUE_REQUEST,
    ENABLE_REQUEST_HOLDING,
    FAIL_REQUEST,
    FULFIL_REQUEST,
    GET_RESPONSE_BODY,
} from "../connection/FetchDomain.ts";
import { errorText } from "../connection/ErrorText.ts";
import { CLICK_WATCH_SCRIPT } from "../page/HitChecks.ts";
import type { PageWatch } from "../page/PageWatch.ts";
import { PRESS_REPORT_BINDING, WorldName } from "../page/WorldName.ts";
import { isAllowedUrl } from "./IsAllowedUrl.ts";
import type { SessionBrowser } from "./SessionBrowser.ts";

// How the browser says a held response has no body to take: it is a redirect or has none, or nothing
// is held any more. Any other failure is reported at the session's close.
const NO_BODY_TO_TAKE =
    /Can only get response body|No data found|No resource with given|Request content was evicted|Invalid InterceptionId|Session with given id not found|connection closed/;

// The target's device, locale, time zone, colour scheme and motion, the determinism script, emulated
// focus (a headless page has none, and the clipboard needs it), the click checks' world, and the
// egress allow-list, whose refusals join the session's blocked origins.
export async function preparePage(
    browser: SessionBrowser,
    sessionId: string,
    watch: PageWatch,
): Promise<void> {
    const { connection, target, environment } = browser;
    const page = connection.session(sessionId);
    const profile = deviceProfile(target);
    await page.ask(SET_DEVICE_METRICS, {
        width: profile.width,
        height: profile.height,
        deviceScaleFactor: profile.scale,
        mobile: profile.mobile,
    });
    if (profile.touch) {
        // The quoted key is the protocol's own parameter name.
        await page.ask(SET_TOUCH_EMULATION, { enabled: true, "maxTouchPoints": 5 });
    }
    await page.ask(SET_LOCALE, { locale: target.locale });
    await page.ask(SET_TIME_ZONE, { timezoneId: target.timezone });
    // navigator.language follows Accept-Language, so the locale needs both overrides.
    await page.ask(SET_USER_AGENT, { userAgent: browser.userAgent, acceptLanguage: target.locale });
    await page.ask(SET_EMULATED_MEDIA, {
        features: [
            { name: "prefers-reduced-motion", value: target.reducedMotion },
            { name: "prefers-color-scheme", value: target.colorScheme },
        ],
    });
    await page.ask(SET_FOCUS_EMULATION, { enabled: true });
    await page.ask(ADD_SCRIPT_ON_NEW_DOCUMENT, {
        source: determinismScript(environment.seed, environment.fixedTimeMilliseconds),
    });
    // The browser tells the driver of a binding's calls only with this domain on.
    await page.ask(ENABLE_RUNTIME, {});
    await page.ask(ADD_BINDING, {
        name: PRESS_REPORT_BINDING,
        executionContextName: WorldName.ClickCheck,
    });
    await page.ask(ADD_SCRIPT_ON_NEW_DOCUMENT, {
        source: CLICK_WATCH_SCRIPT,
        worldName: WorldName.ClickCheck,
    });
    watch.onRequestPaused(sessionId, (paused) => {
        decideOnRequest(browser, paused, watch);
    });
    await page.ask(ENABLE_REQUEST_HOLDING, {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
}

// Every request is paused and either let through (allowed origin) or failed and recorded. An allowed
// fetch or XHR request an active stub matches is answered by the stub instead. A request whose
// response fields a plan may read is held again once its response is in, for its body.
function decideOnRequest(browser: SessionBrowser, paused: RequestPaused, watch: PageWatch): void {
    if (paused.stage === "response") {
        void takeResponseBody(browser.network, paused, watch);
        return;
    }
    const url = URL.parse(paused.request.url);
    // A URL that cannot be parsed is blocked, with no origin to show.
    const isAllowed = url !== null && isAllowedUrl(url, browser.environment.allowedOrigins);
    if (url !== null && !isAllowed) {
        browser.blocked.push(url.origin);
    }
    const stubbed = isAllowed ? browser.network.answer(paused) : null;
    const sendDecision = async (): Promise<void> => {
        if (stubbed !== null) {
            await watch.askAboutHeldRequest(FULFIL_REQUEST, {
                requestId: paused.requestId,
                ...stubbed.response,
            });
            stubbed.onAccepted();
            return;
        }
        if (!isAllowed) {
            await watch.askAboutHeldRequest(FAIL_REQUEST, {
                requestId: paused.requestId,
                errorReason: "BlockedByClient",
            });
            return;
        }
        await watch.askAboutHeldRequest(CONTINUE_REQUEST, {
            requestId: paused.requestId,
            ...(browser.network.wantsResponseBody(paused)
                ? { interceptResponse: true as const }
                : {}),
        });
    };
    sendDecision().catch((error: unknown) => {
        watch.noteDecisionFailure(error);
    });
}

// Takes the body of a response held at the response stage, for the request check that reads its
// fields, then lets the page have it unchanged. A body that cannot be taken is left out: the
// exchange still counts, with no body to read.
async function takeResponseBody(
    network: BrowserNetwork,
    held: RequestAtResponseStage,
    watch: PageWatch,
): Promise<void> {
    if (!held.hasFailed && held.networkId !== undefined) {
        try {
            const fetched = await watch.askAboutHeldRequest(GET_RESPONSE_BODY, {
                requestId: held.requestId,
            });
            network.keepResponseBody(
                held.networkId,
                Buffer.from(fetched.body, fetched.base64Encoded ? "base64" : "utf8"),
            );
        } catch (error) {
            if (!NO_BODY_TO_TAKE.test(errorText(error))) {
                watch.noteCleanUpFailure(
                    `a response's body could not be taken: ${errorText(error)}`,
                );
            }
        }
    }
    await watch
        .askAboutHeldRequest(CONTINUE_REQUEST, { requestId: held.requestId })
        .catch((error: unknown) => {
            watch.noteDecisionFailure(error);
        });
}
