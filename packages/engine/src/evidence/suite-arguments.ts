// What a declared suite's process is started with: the declared command, unchanged and as separate
// strings, then Revisum's own arguments, which the declaration may not set. They come last, so they
// win over whatever the team's Playwright config says:
//   - --retries=0, so a pass is a first-time pass, as in Revisum's own runs;
//   - the JSON reporter, written where PLAYWRIGHT_JSON_OUTPUT_NAME points, inside Revisum's output folder;
//   - traces on, and the test output folder (where traces go) inside Revisum's output folder too,
//     since the checkout is read-only;
//   - one --project per declared project.
// The runner runs the vector without a shell, so no argument is ever read as shell syntax. The
// suite's timeout is the runner's to enforce. See docs/specs/SPEC-35-evidence-mode.md.
import type { EvidenceSuiteDeclaration } from '@revisum/contracts';

// The report's file name, at the top of Revisum's output folder.
export const SUITE_REPORT_FILE = 'report.json';
// The folder, inside Revisum's output folder, where Playwright writes traces and attachments.
export const SUITE_RESULTS_FOLDER = 'test-results';
export const REPORT_PATH_VARIABLE = 'PLAYWRIGHT_JSON_OUTPUT_NAME';

export type SuiteArguments = {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
};

// `outputDirectory` is where the suite's process sees Revisum's output folder.
export function suiteArguments(suite: EvidenceSuiteDeclaration, outputDirectory: string): SuiteArguments {
  const folder = outputDirectory.replace(/\/+$/, '');
  return {
    argv: [
      ...suite.command,
      '--retries=0', '--reporter=json', '--trace=on', `--output=${folder}/${SUITE_RESULTS_FOLDER}`,
      ...suite.projects.map((project) => `--project=${project}`),
    ],
    environment: { [REPORT_PATH_VARIABLE]: `${folder}/${SUITE_REPORT_FILE}` },
  };
}
