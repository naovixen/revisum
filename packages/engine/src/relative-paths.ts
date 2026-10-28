// Relative paths and globs from outside input: a suite's declared paths and working directory, and
// the attachment paths in a suite's report. One rule decides whether such a path stays inside the
// folder it is relative to, so the project parser and the report decoder can never disagree.
// See docs/specs/SPEC-35-evidence-mode.md.

// Forward slashes and no leading "./" or "/", so paths a version-control port reports compare the
// same on every platform.
export const repositoryPath = (path: string): string => path.replaceAll('\\', '/').replace(/^(\.?\/)+/, '');

const DRIVE_LETTER = /^[A-Za-z]:/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// True when `path` can only name something inside its root folder: it is not empty, uses forward
// slashes only, is not absolute, names no drive or network share, and no ".." climbs above the root
// at any point. A backslash is refused outright because Windows reads it as a separator, so
// "..\\x" would leave. In a glob, "**" may match no folder at all, so it counts as no depth.
export function staysInside(path: string): boolean {
  if (path === '' || path.includes('\\') || path.startsWith('/') || DRIVE_LETTER.test(path) || CONTROL_CHARACTER.test(path)) return false;
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '**') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}

// A repository-relative glob as a regular expression: "**" matches any number of folders, "*"
// matches within one file or folder name, and every other character is literal.
function globPattern(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index] ?? '';
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else {
      source += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export const matchesAnyGlob = (path: string, globs: readonly string[]): boolean => globs.some((glob) => globPattern(glob).test(path));
