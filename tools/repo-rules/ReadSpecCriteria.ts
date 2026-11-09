// The acceptance criteria the specs in docs/specs/ define, read for the checks that must name only
// criteria that exist: test metadata, commit trailers, the trace index and the seed record.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A criterion is defined by a list item that starts with its id and a colon in docs/specs/*.md.
// Ids mentioned anywhere else (build notes, other specs) do not define one.
const CRITERION_DEFINITION = /^\s*-\s*(AC-SPEC-(\d{2})-\d{2}):/gm;

export type SpecCriteria = {
  // Spec number as written in its file name ("07"), then the criterion ids it defines, in order.
  readonly bySpec: ReadonlyMap<string, readonly string[]>;
  readonly all: ReadonlySet<string>;
  // Spec numbers that have a file in docs/specs/.
  readonly specNumbers: ReadonlySet<string>;
};

export function readSpecCriteria(root: string): SpecCriteria {
  const folder = join(root, 'docs', 'specs');
  const bySpec = new Map<string, string[]>();
  const specNumbers = new Set<string>();
  const files = existsSync(folder) ? readdirSync(folder).filter((name) => /^SPEC-\d{2}.*\.md$/.test(name)).sort() : [];
  for (const name of files) {
    const specNumber = name.slice(5, 7);
    specNumbers.add(specNumber);
    for (const match of readFileSync(join(folder, name), 'utf8').matchAll(CRITERION_DEFINITION)) {
      const id = match[1] ?? '';
      const owner = match[2] ?? specNumber;
      const list = bySpec.get(owner) ?? [];
      if (!list.includes(id)) list.push(id);
      bySpec.set(owner, list);
    }
  }
  return { bySpec, all: new Set([...bySpec.values()].flat()), specNumbers };
}
