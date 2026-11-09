// Trusted by provenance: core reads trusted files only from the protected default branch, so a
// change under test cannot edit its own judge. project.json that exists only on another branch is
// refused, and a trusted file the change edits is ignored in favour of the protected version and
// raised for review.
import {
  AuditEventKind, CliErrorCode, TrustErrorCode, failure, success, type Approval, type EventSink, type Result, type TrustError, type VersionControlPort, type PlanError,
} from '@revisum/contracts';
import { deriveActor, sourceActorId } from '../approval/DeriveActor.ts';
import { isAnySuiteFile } from '../evidence/SuitePasses.ts';
import { repositoryPath } from '../foundation/RepositoryPath.ts';
import { parseProject, type Project } from './ParseProject.ts';

// Where a trusted project came from: the protected branch at a commit, or an approval of it.
export type Provenance =
  | { readonly kind: 'protected-branch'; readonly branch: string; readonly commit: string }
  | { readonly kind: 'approval'; readonly approval: Approval };

// The key of the TrustedProject mark: declared here and never exported, so only this module can
// make one. Only a type exists: nothing is emitted.
declare const trustedMark: unique symbol;

// A parsed project read from the protected branch. It is a Project too, so whatever takes a
// project takes a trusted one, and its provenance allows nothing more.
export type TrustedProject = Project & { readonly provenance: Provenance; readonly [trustedMark]: true };

// A trusted file that the change under test edited: core ignored the edit and someone should look.
export type TrustedFileReviewItem = { readonly code: 'changed-with-code'; readonly path: string };

// What the change under test touches, and where the loader records the trusted files it edited.
export type ChangeUnderTest = {
  // The files the change edits, relative to the repository root.
  readonly files: readonly string[];
  readonly events: EventSink;
};

// `asWritten` is the file's JSON as read, so a caller never has to read the protected branch again and
// can hand on exactly the project whose trust was checked.
export type LoadedProject = { readonly project: TrustedProject; readonly asWritten: unknown; readonly reviewItems: readonly TrustedFileReviewItem[] };

// config-invalid: the protected-branch project.json exists but is not a valid project.
export type ProjectLoadError = TrustError | { readonly code: 'config-invalid'; readonly path: string; readonly errors: readonly PlanError[] };

// The places GitHub looks for a code-owners file, in the order it looks.
export const CODE_OWNERS_PATHS: readonly string[] = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const TRUSTED_FILES: readonly string[] = ['project.json', 'approvers.json', 'holdouts.json', ...CODE_OWNERS_PATHS];
const TRUSTED_FOLDERS: readonly string[] = ['plans/', 'baselines/'];

export { repositoryPath };

// True for a trusted file: one whose edit could change what core trusts. Everything else in the
// repository is application code, apart from the files of a suite the protected project declares
// (isAnySuiteFile), which are trusted too.
export const isTrustedFile = (path: string): boolean => {
  const normal = repositoryPath(path);
  return TRUSTED_FILES.includes(normal) || TRUSTED_FOLDERS.some((folder) => normal.startsWith(folder));
};

// The actor recorded for the change's edit: its author is not known here, so it is unverified.
const CHANGE_AUTHOR = deriveActor(sourceActorId('change under test'), 'unverified');

// Reads project.json (at `path`, relative to the repository root) from the protected branch. A
// trusted file the change also edits raises a changed-with-code review item and appends one
// trusted.changed-with-code event per file; the protected version is the one used either way.
export async function loadTrustedProject(
  path: string, versionControl: VersionControlPort, change: ChangeUnderTest,
): Promise<Result<LoadedProject, ProjectLoadError>> {
  const projectPath = repositoryPath(path);
  const protectedFile = await versionControl.protectedFile(projectPath);
  // Unavailable is refused too: without the protected version there is nothing core may trust.
  if (!protectedFile.ok) {return failure({ code: TrustErrorCode.UntrustedSource, path: projectPath });}
  const asWritten = parseJson(protectedFile.value.bytes);
  const parsed = parseProject(asWritten);
  if (!parsed.ok) {return failure({ code: CliErrorCode.ConfigInvalid, path: projectPath, errors: parsed.error });}

  // The one place a TrustedProject is made, from the project the parser gave.
  const project = {
    ...parsed.value,
    provenance: { kind: 'protected-branch', branch: versionControl.protectedBranch, commit: protectedFile.value.commit },
  } as TrustedProject;
  // The protected project's suites decide which suite files are trusted, so a change cannot widen
  // or narrow them by editing its own project.json.
  const edited = [...new Set(change.files.map(repositoryPath))]
    .filter((file) => file === projectPath || isTrustedFile(file) || isAnySuiteFile(project.evidenceMode, file)).sort();
  const reviewItems = edited.map((file): TrustedFileReviewItem => ({ code: TrustErrorCode.ChangedWithCode, path: file }));
  // The review items carry the finding whether or not the sink accepts the event.
  for (const item of reviewItems) {change.events.append({ kind: AuditEventKind.TrustedChangedWithCode, path: item.path }, CHANGE_AUTHOR);}
  return success({ project, asWritten, reviewItems });
}

// JSON from file bytes, or undefined when it is not JSON, which the project parser then refuses.
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
