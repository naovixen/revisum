// What golden/replay/windows-signup/ holds: the sign-up plan on the CDP driver, without its capture
// steps so the result holds no screenshot, and the manifest and hashes of a real browser run of it.
// tools/RecordGoldens.ts runs this file, on Windows x64 only, and writes what it prints.
import { signupHarness, signupPlan } from "./signup-harness.ts";

const TARGET_ID = "cdp-chromium";
const FOLDER = "replay/windows-signup";

export async function windowsSignupGolden(): Promise<Readonly<Record<string, unknown>>> {
    const signup = signupPlan([TARGET_ID]);
    const plan = { ...signup, steps: signup.steps.filter((step) => step.type !== "capture") };
    const recording = await signupHarness();
    try {
        const { result } = await recording.run(recording.plan(plan), TARGET_ID);
        if (result.state !== "Passed") {
            throw new Error(
                `the sign-up run ended ${result.state}: ${JSON.stringify(result.steps)}`,
            );
        }
        return {
            [`${FOLDER}/plan.json`]: plan,
            [`${FOLDER}/manifest.json`]: result.manifest,
            [`${FOLDER}/result-hash.json`]: {
                resultHash: result.resultHash,
                manifestHash: result.manifestHash,
            },
        };
    } finally {
        await recording.close();
    }
}

if (import.meta.main) {
    process.stdout.write(JSON.stringify(await windowsSignupGolden()));
}
