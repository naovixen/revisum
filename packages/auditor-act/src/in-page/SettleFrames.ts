/// <reference lib="dom" />
// Waits so blur and focus handlers and short timeouts have run. Each runs inside the page and is sent
// with toString(), so it is self-contained: no imports and no closures over Node values.

// Two animation frames and a short timer.
export function settleFrames(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setTimeout(resolve, 30);
            });
        });
    });
}

// The fonts ready, then two animation frames and a short timer. The page may have taken document.fonts away.
export async function settleFontsAndFrames(): Promise<void> {
    const fonts = document.fonts as FontFaceSet | null | undefined;
    if (fonts !== null && fonts !== undefined) {
        await fonts.ready;
    }
    await new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setTimeout(resolve, 30);
            });
        });
    });
}
