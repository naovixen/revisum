// Runs one local ESLint rule over a source string. ESLint and its TypeScript parser are installed
// only under tools/eslint/, so they are loaded from there.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const requireFromLintTools = createRequire(resolve('tools/eslint/package.json'));
const { Linter } = requireFromLintTools('eslint');
const parser = requireFromLintTools('@typescript-eslint/parser');

export type LintFinding = { readonly messageId: string };

export function lintWithRule(rule: unknown, source: string, repositoryPath: string): readonly LintFinding[] {
  const linter = new Linter({ configType: 'flat', cwd: process.cwd() });
  const config = [{
    files: ['**/*.ts'],
    languageOptions: { parser },
    plugins: { local: { rules: { 'under-test': rule } } },
    rules: { 'local/under-test': 'error' },
  }];
  const messages: readonly { readonly messageId?: string; readonly message: string }[] =
    linter.verify(source, config, { filename: join(process.cwd(), repositoryPath) });
  return messages.map((message) => ({ messageId: message.messageId ?? message.message }));
}
