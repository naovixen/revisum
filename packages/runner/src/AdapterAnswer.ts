// What a port said, as a Result. A rejected promise is a failure too, so a caller never has to tell
// an answered problem from a thrown one, and an adapter that throws can't stop a clean-up.
import { failure, type Result } from "@revisum/contracts";

export type ProblemDetail = { readonly detail: string };

const rejectionDetail = (thrown: unknown): string =>
    thrown instanceof Error ? thrown.message : String(thrown);

export async function adapterAnswer<Value, Problem extends ProblemDetail>(
    answer: () => Promise<Result<Value, Problem>>,
): Promise<Result<Value, Problem | ProblemDetail>> {
    try {
        return await answer();
    } catch (thrown) {
        return failure({ detail: rejectionDetail(thrown) });
    }
}
