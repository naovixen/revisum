// The plan language changelog, read the way the version tests need it: the entry for one version,
// and versions newer than any the changelog lists. Tests look up their own version's entry, never
// "the newest", so opening a new version needs no test edits.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md and docs/specs/SPEC-36-unsafe-plan-features.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from './repository.ts';

export const CHANGELOG_PATH = 'docs/plan-language/CHANGELOG.md';

const HEADING = /^## (\d+)(?:\.(\d+))? \(/;

export const changelogText = (): string => readFileSync(join(REPOSITORY_ROOT, CHANGELOG_PATH), 'utf8');

// The sections of the changelog, newest first, each from its "## " heading to the next.
export const changelogEntries = (): string[] =>
  changelogText().split(/\r?\n(?=## )/).filter((section) => section.startsWith('## '));

const versionOf = (entry: string): { readonly major: number; readonly minor: number } | undefined => {
  const heading = HEADING.exec(entry);
  return heading === null ? undefined : { major: Number(heading[1]), minor: Number(heading[2] ?? 0) };
};

// Every entry headed with exactly `version`, such as "1.2", newest first.
export const entriesFor = (version: string): string[] =>
  changelogEntries().filter((entry) => entry.startsWith(`## ${version} (`));

// The newest entry for `version`, or the empty text when there is none, so a check on it fails
// with the entry's text in view.
export const changelogEntry = (version: string): string => entriesFor(version)[0] ?? '';

// The newest version any changelog entry names.
export function newestListedVersion(): { readonly major: number; readonly minor: number } {
  const versions = changelogEntries().flatMap((entry) => { const version = versionOf(entry); return version === undefined ? [] : [version]; });
  const newest = versions.reduce((best, version) =>
    (version.major > best.major || (version.major === best.major && version.minor > best.minor) ? version : best), { major: 0, minor: 0 });
  return newest;
}

// Versions newer than any the changelog lists: the next minor version, the newest version's text
// with a "0" added (a newer minor whose text starts with a known version's), and the next major.
export function futureVersions(): readonly string[] {
  const { major, minor } = newestListedVersion();
  return [`${major}.${minor + 1}`, `${major}.${minor}0`, `${major + 1}.0`];
}

// Changelog text with its newest entry removed, everything else kept as it was.
export function withoutNewestEntry(text: string): string {
  const sections = text.split(/\r?\n(?=## )/);
  const newest = sections.findIndex((section) => section.startsWith('## '));
  return sections.filter((_, index) => index !== newest).join('\n');
}
