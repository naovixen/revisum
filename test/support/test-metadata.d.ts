// Lets a test carry the id of the acceptance criterion it proves as data, in a `criterion`
// option next to the test's name. Node's test runner ignores the extra option; the trace index
// reads it from the source.
import 'node:test';

declare module 'node:test' {
  namespace test {
    interface TestOptions {
      // The id of the acceptance criterion in docs/specs/ that this test proves.
      criterion?: string;
    }
  }
}
