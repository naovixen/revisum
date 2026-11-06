// The one way a value read during a run becomes a run value. Every step that remembers something is
// handed the run's values read-only and this to add to them, so no source of values can skip what is
// judged here. A remembered value is hashed into the result and a later step can send it on, and a
// hash of a short secret is as good as the secret, so a value holding one is refused before anything
// about it is kept.
import { failure, success, type Result, type SafeText, type StepCode, type ValueName } from "@revisum/contracts";
import { sha256 } from "./hashing.ts";
import type { Logger } from "./logging.ts";
import { runTimeText } from "./plan/plan-decoders.ts";

export type RememberRefusal =
    | typeof StepCode.ValueHoldsSecret
    | typeof StepCode.ValueTooLong
    | typeof StepCode.ValueUnsafe;
export type RememberedRecord = { readonly valueName: ValueName; readonly sha256: string };
type TextToRemember = readonly [ValueName, string];

export interface RememberedValues {
    // Keeps the value and records it in the result and the log, by name and sha256 only.
    remember(
        name: ValueName,
        text: string,
        stepIndex: number,
    ): Result<RememberedRecord, RememberRefusal>;
    // The same for several values at once: all or none, so a refused one leaves the run's values as they were.
    rememberAll(
        texts: readonly TextToRemember[],
        stepIndex: number,
    ): Result<readonly RememberedRecord[], RememberRefusal>;
    // For a declared call, whose result already records its response by sha256. Its values are not
    // recorded on their own, and a failed check's observation does not hide them.
    keepUnrecorded(texts: readonly TextToRemember[]): Result<void, RememberRefusal>;
}

export type RememberedValuesOptions = {
    // The run's values and the texts a failed check's observation never keeps: only this adds to them.
    readonly values: Map<ValueName, SafeText>;
    readonly rememberedTexts: Set<string>;
    // True when a text holds one of the run's secrets, in any form the run looks for.
    readonly hasSecret: (text: string) => boolean;
    readonly maximumTextLength: number;
    readonly logger: Logger;
};

// How a result holds what a step remembered: one value on its own, several as a list, and none not at all.
export function recordsOfRemembered(records: readonly RememberedRecord[]): {
    readonly remembered?: RememberedRecord;
    readonly rememberedValues?: readonly RememberedRecord[];
} {
    const [first, second] = records;
    if (first === undefined) {
        return {};
    }
    return second === undefined ? { remembered: first } : { rememberedValues: records };
}

export function rememberedValues(options: RememberedValuesOptions): RememberedValues {
    const { values, rememberedTexts, hasSecret, maximumTextLength, logger } = options;

    // A remembered value is plan text from then on, so it passes the same rules as plan text.
    const judged = (text: string): Result<SafeText, RememberRefusal> => {
        if (hasSecret(text)) {
            return failure("value-holds-secret");
        }
        if (text.length > maximumTextLength) {
            return failure("value-too-long");
        }
        const safe = runTimeText(text, maximumTextLength);
        return safe === undefined ? failure("value-unsafe") : success(safe);
    };

    const judgedAll = (
        texts: readonly TextToRemember[],
    ): Result<readonly (readonly [ValueName, SafeText])[], RememberRefusal> => {
        const accepted: (readonly [ValueName, SafeText])[] = [];
        for (const [name, text] of texts) {
            const safe = judged(text);
            if (!safe.ok) {
                return safe;
            }
            accepted.push([name, safe.value]);
        }
        return success(accepted);
    };

    const keepAndRecord = (
        name: ValueName,
        safe: SafeText,
        stepIndex: number,
    ): RememberedRecord => {
        values.set(name, safe);
        rememberedTexts.add(safe);
        const digest = sha256(safe);
        logger.log({ kind: "value.remembered", stepIndex, valueName: name, sha256: digest });
        return { valueName: name, sha256: digest };
    };

    return {
        remember(name, text, stepIndex) {
            const safe = judged(text);
            return safe.ok ? success(keepAndRecord(name, safe.value, stepIndex)) : safe;
        },
        rememberAll(texts, stepIndex) {
            const accepted = judgedAll(texts);
            return accepted.ok
                ? success(
                      accepted.value.map(([name, safe]) => keepAndRecord(name, safe, stepIndex)),
                  )
                : accepted;
        },
        keepUnrecorded(texts) {
            const accepted = judgedAll(texts);
            if (!accepted.ok) {
                return accepted;
            }
            for (const [name, safe] of accepted.value) {
                values.set(name, safe);
            }
            return success(undefined);
        },
    };
}
