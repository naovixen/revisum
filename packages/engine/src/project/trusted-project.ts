// Trusted by provenance: core reads trusted files only from the protected default branch, so a
// change under test cannot edit its own judge. project.json that exists only on another branch is
// refused, and a trusted file the change edits is ignored in favour of the protected version and
// raised for review.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import {
  failure, success, type Approval, type Brand, type EventSink, type Result, type TrustError, type VersionControlPort,
} from '@revisum/contracts';
import { deriveActor, sourceActorId } from '../actor.ts';
import { brand } from '../brand.ts';
import { isAnySuiteFile } from '../evidence/suite-choice.ts';
import type { PlanError } from '../plan/plan-decoders.ts';
import { repositoryPath } from '../relative-paths.ts';
import { parseProject, type ProjectData } from './project-parser.ts';

// Where a trusted project came from: the protected branch at a commit, or an approval of it.
export type Provenance =
  | { readonly kind: 'protected-branch'; readonly branch: string; readonly commit: string }
  | { readonly kind: 'approval'; readonly approval: Approval };

export type TrustedProject = Brand<ProjectData & { readonly provenance: Provenance }, 'TrustedProject'>;

// A trusted file that the change under test edited: core ignored the edit and someone should look.
export type TrustedFileReviewItem = { readonly code: 'changed-with-code'; readonly path: string };

// What the change under test touches, and where the loader records the trusted files it edited.
export type ChangeUnderTest = {
  // The files the change edits, relative to the repository root.
  readonly files: readonly string[];
  readonly events: EventSink;
};

export type LoadedProject = { readonly project: TrustedProject; readonly reviewItems: readonly TrustedFileReviewItem[] };

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
  if (!protectedFile.ok) return failure({ code: 'untrusted-source', path: projectPath });
  const parsed = parseProject(parseJson(protectedFile.value.bytes));
  if (!parsed.ok) return failure({ code: 'config-invalid', path: projectPath, errors: parsed.error });

  const project = brand<ProjectData & { readonly provenance: Provenance }, 'TrustedProject'>({
    ...parsed.value,
    provenance: { kind: 'protected-branch', branch: versionControl.protectedBranch, commit: protectedFile.value.commit },
  });
  // The protected project's suites decide which suite files are trusted, so a change cannot widen
  // or narrow them by editing its own project.json.
  const edited = [...new Set(change.files.map(repositoryPath))]
    .filter((file) => file === projectPath || isTrustedFile(file) || isAnySuiteFile(project.evidenceMode, file)).sort();
  const reviewItems = edited.map((file): TrustedFileReviewItem => ({ code: 'changed-with-code', path: file }));
  // The review items carry the finding whether or not the sink accepts the event.
  for (const item of reviewItems) change.events.append({ kind: 'trusted.changed-with-code', path: item.path }, CHANGE_AUTHOR);
  return success({ project, reviewItems });
}

// JSON from file bytes, or undefined when it is not JSON, which the project parser then refuses.
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
