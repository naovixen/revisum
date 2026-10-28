// The naming lint. It fails when a name in the repository carries a research or process id,
// an unexplained abbreviation or a single letter, when a comment cites research instead of
// explaining, or when a criterion id appears anywhere but a test's `criterion` option.
//
// Usage:
//   node tools/lint-names.ts [repository-root]   lint the repository (default: current folder)
//   node tools/lint-names.ts --self-test          plant banned names in a scratch folder and
//                                                 check that the lint rejects them
// See docs/specs/SPEC-00-repo-seed-and-gates.md.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globToPattern } from './glob.ts';
import { NAMING_LINT, type NamingLintConfig, type NamingRule } from './naming-lint-config.ts';

export type NamingViolation = {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly why: string;
};

export type TokenKind = 'identifier' | 'string' | 'template' | 'comment' | 'regex' | 'number' | 'punctuator';
export type Token = { readonly kind: TokenKind; readonly text: string; readonly line: number };

const CODE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const HASH_COMMENT_EXTENSIONS = ['.yml', '.yaml'];
const HASH_COMMENT_FILES = ['CODEOWNERS'];

// After these, a "/" starts a regular expression rather than a division.
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'type', 'interface', 'async', 'default', 'abstract', 'declare']);

// ---------------------------------------------------------------------------------------------
// Words and patterns

// Splits a name into words at case changes and at separators. A word of digits is also tried
// joined to the word before it, so "step-12" and "Step12" both give "step12".
export function splitWords(name: string): string[] {
  const parts: string[] = [];
  for (const chunk of name.split(/[\s_\-./:@#]+/)) {
    parts.push(...(chunk.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []));
  }
  const words: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? '';
    words.push(part);
    const before = parts[index - 1];
    if (/^\d+$/.test(part) && before !== undefined) words.push(before + part);
  }
  return words;
}

// Separators between the parts of a file name, string or JSON key.
const NAME_SEPARATORS = /[\s_\-./:@#]+/;

// A WCAG success criterion number written into a file name, such as "sc2-4-2" in the W3C test
// assets. It is a standard reference, not a research id.
const WCAG_CRITERION_NUMBER = /\bsc\d[-.]\d{1,2}[-.]\d{1,2}(?![\d])/gi;

// True for a part that is an opaque machine id rather than words. Splitting such a part into
// words gives chance fragments such as "d00" or "f7" that look like research ids.
//   - A hex digest or digest prefix: 7 or more lowercase hex characters with letters and digits,
//     as in "d00ee434a168" or a Git hash.
//   - A W3C ACT rule id: 6 lowercase letters and digits, as in "afw4f7" or "oj04fd". It counts
//     as opaque when it has two or more separate runs of digits, or when its own words break no
//     rule, so a lowercase name that starts with a banned id is still reported.
// Names declared in code are never treated this way, and mixed-case or short parts are always
// checked. The self-test below plants examples of both.
function isOpaqueId(checker: Checker, part: string): boolean {
  const hasLetter = /[a-z]/.test(part);
  const hasDigit = /\d/.test(part);
  if (!hasLetter || !hasDigit) return false;
  if (/^[0-9a-f]{7,}$/.test(part)) return true;
  if (!/^[a-z0-9]{6}$/.test(part)) return false;
  if ((part.match(/\d+/g) ?? []).length >= 2) return true;
  return splitWords(part).every((word) => firstMatch(checker.config.bannedWords, word) === undefined);
}

// The name with WCAG criterion numbers and opaque machine ids removed, keeping the remaining
// parts apart so that no word is joined across a removed part.
function withoutOpaqueIds(checker: Checker, name: string): string {
  return name.replace(WCAG_CRITERION_NUMBER, ' ').split(NAME_SEPARATORS)
    .map((part) => (isOpaqueId(checker, part) ? ' ' : part)).join('-');
}

type Checker = {
  readonly config: NamingLintConfig;
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
  readonly spellOutWords: ReadonlyMap<string, string>;
};

function createChecker(config: NamingLintConfig): Checker {
  return {
    config,
    include: config.include.map(globToPattern),
    exclude: config.exclude.map(globToPattern),
    spellOutWords: new Map(Object.entries(config.spellOut)),
  };
}

function firstMatch(rules: readonly NamingRule[], text: string): string | undefined {
  return rules.find((rule) => rule.pattern.test(text))?.why;
}

// Reasons a name breaks the rules. `spellOut` applies only to names declared in code: file
// names, string values and JSON or YAML keys often follow outside formats (".md", "env:"),
// and may carry opaque machine ids, which are skipped (see isOpaqueId).
function nameProblems(checker: Checker, name: string, isDeclaredInCode: boolean): string[] {
  const problems: string[] = [];
  const claim = firstMatch(checker.config.bannedText, name);
  if (claim !== undefined) problems.push(claim);
  const checkAbbreviations = isDeclaredInCode;
  for (const word of splitWords(isDeclaredInCode ? name : withoutOpaqueIds(checker, name))) {
    if (checker.config.allowedWords.includes(word)) continue;
    const banned = firstMatch(checker.config.bannedWords, word);
    if (banned !== undefined) problems.push(`${banned} ("${word}")`);
    const replacement = checkAbbreviations ? checker.spellOutWords.get(word.toLowerCase()) : undefined;
    if (replacement !== undefined) problems.push(`abbreviation "${word}": write "${replacement}"`);
  }
  return problems;
}

function isNameLike(text: string): boolean {
  return text.length > 1 && /[A-Za-z]/.test(text) && /^[\w$@#:./-]+$/.test(text);
}

// ---------------------------------------------------------------------------------------------
// Tokenizer for TypeScript and JavaScript. It recognises only what the lint needs: names,
// strings, template text, comments and regular expressions, so that each is checked by the
// right rule and the contents of strings and regular expressions are never read as names.

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  // One entry per open "{": true when that brace opened a template substitution "${".
  const braces: boolean[] = [];
  let line = 1;
  let position = 0;

  const lastSignificant = (): Token | undefined => {
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index];
      if (token !== undefined && token.kind !== 'comment') return token;
    }
    return undefined;
  };

  const readTemplateText = (): void => {
    // Called with position just after "`" or after the "}" closing a substitution.
    const startLine = line;
    let text = '';
    while (position < source.length) {
      const character = source[position] ?? '';
      if (character === '\\') {
        text += source.slice(position, position + 2);
        position += 2;
        continue;
      }
      if (character === '`') {
        position += 1;
        tokens.push({ kind: 'template', text, line: startLine });
        return;
      }
      if (character === '$' && source[position + 1] === '{') {
        position += 2;
        braces.push(true);
        tokens.push({ kind: 'template', text, line: startLine });
        return;
      }
      if (character === '\n') line += 1;
      text += character;
      position += 1;
    }
    tokens.push({ kind: 'template', text, line: startLine });
  };

  while (position < source.length) {
    const character = source[position] ?? '';
    const next = source[position + 1] ?? '';

    if (character === '\n') {
      line += 1;
      position += 1;
    } else if (/\s/.test(character)) {
      position += 1;
    } else if (character === '/' && next === '/') {
      const end = source.indexOf('\n', position);
      const stop = end === -1 ? source.length : end;
      tokens.push({ kind: 'comment', text: source.slice(position, stop), line });
      position = stop;
    } else if (character === '/' && next === '*') {
      const end = source.indexOf('*/', position + 2);
      const stop = end === -1 ? source.length : end + 2;
      const text = source.slice(position, stop);
      tokens.push({ kind: 'comment', text, line });
      line += text.split('\n').length - 1;
      position = stop;
    } else if (character === '"' || character === "'") {
      let index = position + 1;
      while (index < source.length && source[index] !== character && source[index] !== '\n') {
        index += source[index] === '\\' ? 2 : 1;
      }
      tokens.push({ kind: 'string', text: source.slice(position + 1, index), line });
      position = index + 1;
    } else if (character === '`') {
      position += 1;
      readTemplateText();
    } else if (character === '/' && startsExpression(lastSignificant())) {
      let index = position + 1;
      let inClass = false;
      while (index < source.length && source[index] !== '\n') {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) break;
        index += 1;
      }
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index] ?? '')) index += 1;
      tokens.push({ kind: 'regex', text: source.slice(position, index), line });
      position = index;
    } else if (/[A-Za-z_$]/.test(character)) {
      const match = /^[\w$]+/.exec(source.slice(position)) ?? [''];
      tokens.push({ kind: 'identifier', text: match[0], line });
      position += match[0].length;
    } else if (/\d/.test(character)) {
      const match = /^[\w.]+/.exec(source.slice(position)) ?? [''];
      tokens.push({ kind: 'number', text: match[0], line });
      position += match[0].length;
    } else if (character === '{') {
      braces.push(false);
      tokens.push({ kind: 'punctuator', text: character, line });
      position += 1;
    } else if (character === '}') {
      position += 1;
      if (braces.pop() === true) readTemplateText();
      else tokens.push({ kind: 'punctuator', text: character, line });
    } else {
      tokens.push({ kind: 'punctuator', text: character, line });
      position += 1;
    }
  }
  return tokens;
}

function startsExpression(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.kind === 'identifier') return KEYWORDS_BEFORE_EXPRESSION.has(previous.text);
  if (previous.kind === 'punctuator') return ![')', ']', '}'].includes(previous.text);
  return false;
}

function stripCommentMarkers(comment: string): string {
  return comment.startsWith('//')
    ? comment.replace(/^\s*\/\/+/gm, '')
    : comment.replace(/^\/\*+/, '').replace(/\*\/$/, '').replace(/^\s*\*/gm, '');
}

// ---------------------------------------------------------------------------------------------
// Per-file checks

function lintComment(checker: Checker, file: string, line: number, comment: string, violations: NamingViolation[]): void {
  const text = stripCommentMarkers(comment);
  // A claim id is the more specific reason, so it is reported before the research-id patterns.
  const why = firstMatch(checker.config.bannedText, text) ?? firstMatch(checker.config.bannedInComments, text);
  if (why !== undefined) violations.push({ file, line, name: text.trim().slice(0, 80), why });
  if (checker.config.criterionIdPattern.test(text)) {
    violations.push({ file, line, name: text.trim().slice(0, 80), why: 'criterion id outside test metadata' });
  }
}

function lintCode(checker: Checker, file: string, source: string, violations: NamingViolation[]): void {
  const tokens = tokenize(source);
  const significant = tokens.filter((token) => token.kind !== 'comment');
  const isTestFile = file.startsWith('test/');
  let insideExportList = false;

  // A run of "//" lines with no code between them is one comment.
  const comments: Token[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== 'comment') return;
    const previous = tokens[index - 1];
    const last = comments.at(-1);
    const continuesRun = last !== undefined && previous?.kind === 'comment' && previous.text.startsWith('//')
      && token.text.startsWith('//') && token.line === previous.line + 1;
    if (continuesRun) comments[comments.length - 1] = { ...last, text: `${last.text}\n${token.text}` };
    else comments.push(token);
  });
  for (const comment of comments) lintComment(checker, file, comment.line, comment.text, violations);

  for (let index = 0; index < significant.length; index++) {
    const token = significant[index];
    if (token === undefined) continue;
    const before = significant[index - 1];
    const twoBefore = significant[index - 2];

    if (token.kind === 'punctuator' && token.text === '{' && before?.text === 'export') insideExportList = true;
    if (token.kind === 'punctuator' && token.text === '}') insideExportList = false;

    if (token.kind === 'string' || token.kind === 'template') {
      if (checker.config.criterionIdPattern.test(token.text)) {
        const isTestMetadata = isTestFile && token.kind === 'string' && before?.text === ':' && twoBefore?.text === 'criterion';
        if (!isTestMetadata) {
          violations.push({ file, line: token.line, name: token.text, why: 'criterion id outside test metadata' });
        }
        continue;
      }
      const problems = token.kind === 'string' && isNameLike(token.text) && !checker.config.allowedStringValues.includes(token.text)
        ? nameProblems(checker, token.text, false)
        : [firstMatch(checker.config.bannedText, token.text)].filter((why) => why !== undefined);
      for (const why of problems) violations.push({ file, line: token.line, name: token.text, why });
      continue;
    }

    if (token.kind !== 'identifier') continue;
    // A name after "." belongs to whatever object it is read from; ours are checked where declared.
    const isMemberAccess = before?.text === '.' && twoBefore?.text !== '.';
    if (isMemberAccess) continue;

    for (const why of nameProblems(checker, token.text, true)) {
      violations.push({ file, line: token.line, name: token.text, why });
    }

    if (/^[A-Za-z]$/.test(token.text)) {
      if (insideExportList || isExportedDeclaration(significant, index)) {
        violations.push({ file, line: token.line, name: token.text, why: 'single-letter exported name' });
      } else if (!checker.config.singleLetterNames.includes(token.text)) {
        violations.push({ file, line: token.line, name: token.text, why: `single-letter name: only ${checker.config.singleLetterNames.join(', ')} are allowed` });
      }
    }
  }
}

function isExportedDeclaration(tokens: readonly Token[], index: number): boolean {
  for (let back = index - 1; back >= 0 && back >= index - 4; back--) {
    const text = tokens[back]?.text;
    if (text === 'export') return true;
    if (text === undefined || !DECLARATION_KEYWORDS.has(text)) return false;
  }
  return false;
}

function lintJson(checker: Checker, file: string, source: string, violations: NamingViolation[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    violations.push({ file, line: 0, name: file, why: 'not valid JSON, so its keys cannot be checked' });
    return;
  }
  const lineOf = (text: string): number => {
    const offset = source.indexOf(JSON.stringify(text));
    return offset === -1 ? 0 : source.slice(0, offset).split('\n').length;
  };
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (checker.config.criterionIdPattern.test(value)) {
        violations.push({ file, line: lineOf(value), name: value, why: 'criterion id outside test metadata' });
      }
      const problems = isNameLike(value) && !checker.config.allowedStringValues.includes(value)
        ? nameProblems(checker, value, false)
        : [firstMatch(checker.config.bannedText, value)].filter((why) => why !== undefined);
      for (const why of problems) violations.push({ file, line: lineOf(value), name: value, why });
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        for (const why of nameProblems(checker, key, false)) violations.push({ file, line: lineOf(key), name: key, why });
        visit(child);
      }
    }
  };
  visit(parsed);
}

function lintHashCommented(checker: Checker, file: string, source: string, violations: NamingViolation[]): void {
  source.split('\n').forEach((text, index) => {
    const line = index + 1;
    const commentStart = text.search(/(^|\s)#/);
    if (commentStart !== -1) lintComment(checker, file, line, text.slice(commentStart).replace(/^\s*#/, ''), violations);
    const key = /^\s*-?\s*([\w-]+)\s*:/.exec(text)?.[1];
    if (key !== undefined) {
      for (const why of nameProblems(checker, key, false)) violations.push({ file, line, name: key, why });
    }
  });
}

function lintPlainText(checker: Checker, file: string, source: string, violations: NamingViolation[]): void {
  source.split('\n').forEach((text, index) => {
    const why = firstMatch(checker.config.bannedText, text);
    if (why !== undefined) violations.push({ file, line: index + 1, name: text.trim().slice(0, 80), why });
  });
}

// ---------------------------------------------------------------------------------------------
// Repository walk

function listFiles(root: string, folder = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function lintRepository(root: string, config: NamingLintConfig = NAMING_LINT): NamingViolation[] {
  const checker = createChecker(config);
  const violations: NamingViolation[] = [];
  const checkedFolders = new Set<string>();

  const files = listFiles(root).filter((file) =>
    checker.include.some((pattern) => pattern.test(file)) && !checker.exclude.some((pattern) => pattern.test(file)));

  for (const file of files) {
    const segments = file.split('/');
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join('/');
      const isFolder = index < segments.length - 1;
      if (isFolder && checkedFolders.has(path)) return;
      if (isFolder) checkedFolders.add(path);
      for (const why of nameProblems(checker, segment, false)) violations.push({ file: path, line: 0, name: segment, why });
    });

    const source = readFileSync(join(root, file), 'utf8');
    const fileName = segments.at(-1) ?? file;
    const extension = /\.[^.]+$/.exec(fileName)?.[0] ?? '';
    if (CODE_EXTENSIONS.includes(extension)) lintCode(checker, file, source, violations);
    else if (extension === '.json') lintJson(checker, file, source, violations);
    else if (HASH_COMMENT_EXTENSIONS.includes(extension) || HASH_COMMENT_FILES.includes(fileName)) lintHashCommented(checker, file, source, violations);
    else lintPlainText(checker, file, source, violations);
  }
  // The same name used twice on one line is reported once.
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = JSON.stringify(violation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Self-test: plant names the lint must reject, and a clean file it must accept.

type PlantedCase = { readonly path: string; readonly source: string; readonly expectedWhy: string };
type CleanFile = { readonly path: string; readonly source: string };

// Built from parts so that this file does not itself contain a claim id.
const PLANTED_CLAIM_ID = ['C', 'R' + '10', '001'].join('-');

const PLANTED_CASES: readonly PlantedCase[] = [
  { path: 'packages/demo/src/planted-name.ts', source: 'export const R11Test = 1;\n', expectedWhy: 'research requirement id' },
  { path: 'packages/demo/src/planted-letter.ts', source: 'export const T = 1;\n', expectedWhy: 'single-letter exported name' },
  { path: 'packages/demo/src/planted-comment.ts', source: '// See 04 Finding 1.\nexport const value = 1;\n', expectedWhy: 'research doc citation' },
  { path: 'packages/demo/src/planted-abbreviation.ts', source: 'export const acId = 1;\n', expectedWhy: 'acceptance criterion: write "criterion"' },
  { path: 'packages/demo/src/planted-spike.ts', source: 'export const p3Core = 1;\n', expectedWhy: 'spike name' },
  { path: 'packages/demo/src/planted-job.ts', source: 'export function checkD14(): void {}\n', expectedWhy: 'research job id' },
  // A function key is allowed as a string value only: as a name, or past F12, it is still a job id.
  { path: 'packages/demo/src/planted-key-name.ts', source: 'export const F5 = 1;\n', expectedWhy: 'research job id' },
  { path: 'packages/demo/src/planted-key-value.ts', source: "export const key = 'F13';\n", expectedWhy: 'research job id' },
  { path: 'packages/demo/planted-key-in-json.json', source: '{ "F7": "Escape" }\n', expectedWhy: 'research job id' },
  { path: 'packages/demo/planted-key.json', source: '{ "RC-04": true }\n', expectedWhy: 'role criterion, requirement or user-problem id' },
  { path: 'packages/demo/src/planted-error-code.ts', source: "export const failureCode = 'h12-failed';\n", expectedWhy: 'hypothesis id' },
  { path: 'packages/demo/src/planted-claim.ts', source: `// Backed by ${PLANTED_CLAIM_ID}.\nexport const value = 1;\n`, expectedWhy: 'claim id' },
  // A lowercase name that starts with a banned id is not mistaken for an opaque machine id.
  { path: 'packages/demo/planted-lowercase.json', source: '{ "name": "p3core" }\n', expectedWhy: 'spike name' },
];

const CLEAN_FILES: readonly CleanFile[] = [
  {
    path: 'packages/demo/src/clean.ts',
    source: [
      '// Deny by default: an unknown action could be destructive. See docs/specs/SPEC-09-privacy-masking.md',
      'export const dependencyReview = { criterionId: "", width: 0 };',
      'for (let i = 0; i < 2; i++) dependencyReview.width += i;',
      '',
    ].join('\n'),
  },
  {
    // Hex digests, W3C ACT rule ids and WCAG criterion numbers in data are not research ids.
    path: 'packages/demo/clean-ids.json',
    source: JSON.stringify({
      sha256: 'd00ee434a16816f558853770237bbc61579eeb881292c68ce7c40f302e76e6ee',
      rules: ['afw4f7', 'b4f0c3', 'oj04fd'],
      finding: 'sc212-keyboard-trap.fail.oj04fd.3',
      asset: 'test-assets/sc2-4-2-title-page-with-title.html',
      keys: ['F1', 'F12'],
    }),
  },
  {
    // The function keys F1 to F12 are keyboard keys when written as string values.
    path: 'packages/demo/src/clean-keys.ts',
    source: "export const functionKeys = ['F1', 'F5', 'F12'];\n",
  },
];

function runSelfTest(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'naming-lint-'));
  let passed = true;
  try {
    for (const file of [...PLANTED_CASES, ...CLEAN_FILES]) {
      mkdirSync(join(root, dirname(file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.source);
    }
    const violations = lintRepository(root);
    for (const planted of PLANTED_CASES) {
      const found = violations.filter((violation) => violation.file === planted.path);
      const caught = found.some((violation) => violation.why.startsWith(planted.expectedWhy));
      console.log(`${caught ? 'ok  ' : 'FAIL'} planted ${planted.path}: ${caught ? `rejected with "${planted.expectedWhy}"` : 'not rejected'}`);
      passed &&= caught;
    }
    for (const clean of CLEAN_FILES) {
      const cleanViolations = violations.filter((violation) => violation.file === clean.path);
      for (const violation of cleanViolations) console.log(`FAIL clean file rejected: ${format(violation)}`);
      if (cleanViolations.length === 0) console.log(`ok   clean ${clean.path}: accepted`);
      passed &&= cleanViolations.length === 0;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return passed;
}

function format(violation: NamingViolation): string {
  return `${violation.file}:${violation.line}  ${violation.name}  — ${violation.why}`;
}

function main(argumentList: readonly string[]): number {
  if (argumentList.includes('--self-test')) {
    const passed = runSelfTest();
    console.log(passed ? 'naming lint self-test passed' : 'naming lint self-test FAILED');
    return passed ? 0 : 1;
  }
  const root = argumentList[0] ?? process.cwd();
  const violations = lintRepository(root);
  for (const violation of violations) console.error(format(violation));
  console.log(violations.length === 0 ? 'naming lint passed' : `naming lint failed: ${violations.length} problem(s)`);
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
