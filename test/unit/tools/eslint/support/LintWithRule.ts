// Runs one local ESLint rule over a source string. ESLint and its TypeScript parser are installed
// only under tools/eslint/, so they are loaded from there.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const requireFromLintTools = createRequire(resolve('tools/eslint/package.json'));
const { Linter } = requireFromLintTools('eslint') as { readonly Linter: RuleLinterConstructor };
const parser = requireFromLintTools('@typescript-eslint/parser') as object;

export type LintFinding = { readonly messageId: string };

type LintMessage = { readonly messageId?: string; readonly message: string; readonly fatal?: boolean };
type RuleLinter = {
  verify(source: string, config: readonly object[], options: { readonly filename: string }): readonly LintMessage[];
};
type RuleLinterConstructor = new (options: { readonly configType: 'flat'; readonly cwd: string }) => RuleLinter;

export function lintWithRule(rule: unknown, source: string, repositoryPath: string): readonly LintFinding[] {
  const linter = new Linter({ configType: 'flat', cwd: process.cwd() });
  const config = [{
    files: ['**/*.ts'],
    languageOptions: { parser },
    plugins: { local: { rules: { 'under-test': rule } } },
    rules: { 'local/under-test': 'error' },
  }];
  const messages = linter.verify(source, config, { filename: join(process.cwd(), repositoryPath) });
  return messages.map((message) => ({ messageId: message.messageId ?? message.message }));
}

// A small TypeScript project for a rule that needs type information: browser and JavaScript
// libraries, and Node's types from the repository's own install.
const TYPED_PROJECT_CONFIG = {
  compilerOptions: {
    target: 'es2024',
    lib: ['es2024', 'dom'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    types: ['node'],
    typeRoots: [resolve('node_modules/@types')],
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['**/*.ts'],
};

// Writes the files, by path within the project, to a fresh folder, lints one of them with the rule
// and its options, and removes the folder. A file the parser cannot read throws, so a broken case
// never passes as clean.
export function lintWithTypedRule(
  rule: unknown,
  files: Readonly<Record<string, string>>,
  lintedPath: string,
  options: readonly unknown[] = [],
): readonly LintFinding[] {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'typed-lint-rule-')));
  try {
    writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify(TYPED_PROJECT_CONFIG));
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), source);
    }
    const source = files[lintedPath];
    if (source === undefined) {
      throw new Error(`no file ${lintedPath} to lint`);
    }
    const linter = new Linter({ configType: 'flat', cwd: folder });
    const config = [{
      files: ['**/*.ts'],
      languageOptions: { parser, parserOptions: { project: join(folder, 'tsconfig.json'), tsconfigRootDir: folder } },
      plugins: { local: { rules: { 'under-test': rule } } },
      rules: { 'local/under-test': ['error', ...options] },
    }];
    const messages = linter.verify(source, config, { filename: join(folder, lintedPath) });
    const fatal = messages.find((message) => message.fatal === true);
    if (fatal !== undefined) {
      throw new Error(`could not lint ${lintedPath}: ${fatal.message}`);
    }
    return messages.map((message) => ({ messageId: message.messageId ?? message.message }));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
