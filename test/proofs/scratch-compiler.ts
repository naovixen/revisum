// Type-checks chosen files on their own, under the repository's strict compiler settings, from a
// throw-away folder. Tests use it to prove that a file compiles, and that a deliberately broken
// copy of it does not, without touching the working tree.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from '../support/repository.ts';

export type CompileOutcome = {
  readonly passed: boolean;
  readonly output: string;
  // One entry per "error TSnnnn" line the compiler printed.
  readonly errors: readonly string[];
};

const forwardSlashes = (path: string): string => path.replaceAll('\\', '/');

// Compiles the given files, each either an absolute path or a { name, source } pair written into
// the scratch folder first. Imports of '@revisum/<package>' resolve to the package sources.
export function compileFiles(files: readonly (string | { readonly name: string; readonly source: string })[]): CompileOutcome {
  const folder = mkdtempSync(join(tmpdir(), 'compile-'));
  try {
    // Without a package.json saying "module", nodenext treats the scratch files as CommonJS.
    writeFileSync(join(folder, 'package.json'), '{"type":"module"}');
    const paths = files.map((file) => {
      if (typeof file === 'string') return forwardSlashes(file);
      const path = join(folder, file.name);
      writeFileSync(path, file.source);
      return forwardSlashes(path);
    });
    const configPath = join(folder, 'tsconfig.json');
    writeFileSync(configPath, JSON.stringify({
      extends: forwardSlashes(join(REPOSITORY_ROOT, 'tsconfig.base.json')),
      compilerOptions: {
        composite: false,
        declaration: false,
        emitDeclarationOnly: false,
        noEmit: true,
        typeRoots: [forwardSlashes(join(REPOSITORY_ROOT, 'node_modules', '@types'))],
      },
      files: paths,
    }, null, 2));
    const compiler = join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const checked = spawnSync(process.execPath, [compiler, '--noEmit', '-p', configPath], { encoding: 'utf8', timeout: 240_000 });
    const output = (checked.stdout ?? '') + (checked.stderr ?? '');
    const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
    return { passed: checked.status === 0, output, errors };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
