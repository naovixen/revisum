// Finds files a browser wrote to disk during a test, wherever its driver put them: the system's
// temporary folder (where a driver makes its per-run folders), the working folder and the user's
// downloads folder. Only folders changed since the test began are searched below the top, so the
// search stays quick: a folder made, or written into, during the test always has a newer time.
// A test plants a marker in each file the server sends, then asks which files on disk hold it.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// File times can be coarser than the clock that read `since`.
const TIME_SLACK_MILLISECONDS = 2000;
const MAXIMUM_DEPTH = 8;
// Bigger files are not read: no download in these tests is near this size.
const MAXIMUM_READ_BYTES = 4 * 1024 * 1024;

// The folders a download could land in when nothing stops it.
export const downloadSearchRoots = (): readonly string[] => [...new Set([tmpdir(), process.cwd(), join(homedir(), 'Downloads')])];

const statOf = (path: string): Stats | undefined => {
  try { return lstatSync(path); } catch { return undefined; }
};
const entriesOf = (folder: string): readonly string[] => {
  try { return readdirSync(folder); } catch { return []; }
};

// Every ordinary file under the roots changed at or after `since` (milliseconds since the epoch).
export function filesChangedSince(since: number, roots: readonly string[] = downloadSearchRoots()): readonly string[] {
  const found: string[] = [];
  const earliest = since - TIME_SLACK_MILLISECONDS;
  const visit = (folder: string, depth: number): void => {
    for (const entry of entriesOf(folder)) {
      const path = join(folder, entry);
      const stats = statOf(path);
      if (stats === undefined || stats.isSymbolicLink() || stats.mtimeMs < earliest) continue;
      if (stats.isFile()) found.push(path);
      else if (stats.isDirectory() && depth < MAXIMUM_DEPTH) visit(path, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return found;
}

// The files changed since `since` whose bytes hold the marker.
export function filesHolding(marker: string, since: number, roots?: readonly string[]): readonly string[] {
  const needle = Buffer.from(marker, 'utf8');
  return filesChangedSince(since, roots).filter((path) => {
    const stats = statOf(path);
    if (stats === undefined || stats.size > MAXIMUM_READ_BYTES) return false;
    try { return readFileSync(path).includes(needle); } catch { return false; }
  });
}

// The files changed since `since` whose name holds the text, in any case.
export function filesNamed(text: string, since: number, roots?: readonly string[]): readonly string[] {
  const folded = text.toLowerCase();
  return filesChangedSince(since, roots).filter((path) => basename(path).toLowerCase().includes(folded));
}

// Windows' reserved device names, with or without an extension, which a file must never be named.
export const isDeviceName = (name: string): boolean => /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name);

// The folder a file sits in.
export const folderOf = (path: string): string => dirname(path);
