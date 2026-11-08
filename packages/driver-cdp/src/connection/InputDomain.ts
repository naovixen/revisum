// The commands that send a page input.
import { browserCommand, NOTHING_TO_READ } from "./BrowserCommand.ts";

export const INPUT_DOMAIN = "Input";

export const DISPATCH_MOUSE_EVENT = browserCommand<{
    readonly type: "mouseMoved" | "mousePressed" | "mouseReleased";
    readonly x: number;
    readonly y: number;
    readonly button?: "left";
    readonly clickCount?: number;
}>()(`${INPUT_DOMAIN}.dispatchMouseEvent`, NOTHING_TO_READ);

export const DISPATCH_KEY_EVENT = browserCommand<{
    readonly type: "rawKeyDown" | "keyDown" | "keyUp";
    readonly key: string;
    readonly code: string;
    readonly windowsVirtualKeyCode: number;
    readonly nativeVirtualKeyCode?: number;
    readonly modifiers: number;
    readonly location?: number;
    readonly text?: string;
}>()(`${INPUT_DOMAIN}.dispatchKeyEvent`, NOTHING_TO_READ);

export const INSERT_TEXT = browserCommand<{ readonly text: string }>()(
    `${INPUT_DOMAIN}.insertText`,
    NOTHING_TO_READ,
);
