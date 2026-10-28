// Which suite `run --suite <name>` runs, which files are the suite's, and which passes a change
// gets. A suite's declared paths are trusted files: the gating pass always runs the protected
// branch's version of them, and a change's own version runs only as a proposal pass, which never
// opens the merge gate. So a change cannot make its run pass by editing its own tests.
// See docs/specs/SPEC-35-evidence-mode.md.
import { failure, success, type EvidenceMode, type EvidenceSuiteDeclaration, type Result, type SuitePass } from '@revisum/contracts';
import type { EvidenceRefusal } from '../lifecycle.ts';
import type { ProjectData } from '../project/project-parser.ts';
import { matchesAnyGlob, repositoryPath } from '../relative-paths.ts';

// The suite of that name, or the refusal `run --suite` ends with before any container starts.
// `project` is the trusted one, so a change's own evidenceMode section is never what is read here.
export function declaredSuite(project: ProjectData, name: string): Result<EvidenceSuiteDeclaration, EvidenceRefusal> {
  if (project.evidenceMode === undefined) return failure({ code: 'evidence-mode-disabled' });
  const suite = project.evidenceMode.suites.find((candidate) => candidate.name === name);
  return suite === undefined ? failure({ code: 'suite-not-declared' }) : success(suite);
}

// True when the repository-relative `path` is one of the suite's files.
export const isSuiteFile = (suite: EvidenceSuiteDeclaration, path: string): boolean => matchesAnyGlob(repositoryPath(path), suite.paths);

// True when `path` is a file of any suite the evidenceMode section declares.
export const isAnySuiteFile = (evidenceMode: EvidenceMode | undefined, path: string): boolean =>
  (evidenceMode?.suites ?? []).some((suite) => isSuiteFile(suite, path));

// One pass of a suite over a change, and whose version of the suite files it runs.
export type PlannedSuitePass = { readonly pass: SuitePass; readonly suiteFiles: 'protected-branch' | 'change' };

// The gating pass, always on the protected branch's suite files; then, when the change edits a
// suite file and the suite runs changed tests as a proposal, the proposal pass on the change's own.
export function suitePasses(suite: EvidenceSuiteDeclaration, changedFiles: readonly string[]): readonly PlannedSuitePass[] {
  const gating: PlannedSuitePass = { pass: 'gating', suiteFiles: 'protected-branch' };
  const editsSuite = changedFiles.some((file) => isSuiteFile(suite, file));
  return editsSuite && suite.runChangedTestsAsProposal ? [gating, { pass: 'proposal', suiteFiles: 'change' }] : [gating];
}
