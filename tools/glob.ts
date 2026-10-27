// Turns a repository-relative glob into a regular expression. "**" matches any number of
// folders, "*" matches within one file or folder name, and every other character is literal.
export function globToPattern(glob: string): RegExp {
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

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToPattern(glob).test(path));
}
