// A log that cannot throw. A log that breaks has nothing left to report with, and must not stop a
// removal or change what a run answers.
export const safeLog =
    <Entry>(log: (entry: Entry) => void) =>
    (entry: Entry): void => {
        try {
            log(entry);
        } catch {
            // The log is what failed.
        }
    };
