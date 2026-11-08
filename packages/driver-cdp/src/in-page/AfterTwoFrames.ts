/// <reference lib="dom" />
// How long what an action started takes to reach the browser.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// Waits two animation frames, so whatever an action started (a popup, a download) has reached
// the browser before the driver looks.
export async function afterTwoFrames(): Promise<string> {
    const nextFrame = (): Promise<void> =>
        new Promise((resolve) => {
            let isDone = false;
            const finish = (): void => {
                if (!isDone) {
                    isDone = true;
                    resolve();
                }
            };
            requestAnimationFrame(() => finish());
            setTimeout(finish, 50); // a hidden or throttled page may not paint
        });
    await nextFrame();
    await nextFrame();
    return "ok";
}
