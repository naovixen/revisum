// Keeps branded types honest. A value of a branded type, such as SafeText or Plan, means "checked
// by its owning parser", so only that module may create one. This check fails, naming the file,
// when code elsewhere in packages/ or tools/ creates one by a cast (`as SafeText`,
// `as unknown as SafeText`, `<SafeText>value`) or by the engine's brand() helper.
//
// The same rule keeps DerivedActor, the actor recorded on every audit event, out of callers' hands:
// only the engine's actor module (and later the approval verifier) may build one, so no caller can
// choose its own actor type.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator, listSourceFiles } from './source-files.ts';
import { reportProblems } from './workspace-packages.ts';

const PLAN_PARSER = 'packages/engine/src/plan/plan-parser.ts';
const PROJECT_PARSER = 'packages/engine/src/project/project-parser.ts';
const ACTOR_MODULE = 'packages/engine/src/actor.ts';

// Each branded type, and the only files that may create a value of it. A branded type declared in
// packages/ but missing here is still checked: it has no owner, so any cast to it fails until its
// owning parser is listed.
export const BRAND_OWNERS: Readonly<Record<string, readonly string[]>> = {
  // The generic brand: only the engine's brand() helper casts to it.
  Brand: ['packages/engine/src/brand.ts'],
  SafeText: ['packages/engine/src/plan/plan-decoders.ts'],
  AllowedUrl: [PLAN_PARSER],
  CaptureName: [PLAN_PARSER],
  FeatureId: [PLAN_PARSER],
  Plan: [PLAN_PARSER],
  Project: [PROJECT_PARSER],
  TargetId: [PROJECT_PARSER],
  AdapterId: [PROJECT_PARSER],
  Locale: [PROJECT_PARSER],
  TimeZone: [PROJECT_PARSER],
  Origin: [PROJECT_PARSER],
  ValidReport: ['packages/report/src/model/report-parser.ts'],
  ActorId: [ACTOR_MODULE],
  DerivedActor: [ACTOR_MODULE],
};
const ACTOR_BRANDS = new Set(['ActorId', 'DerivedActor']);

// After these words an angle bracket starts an expression, so `<Name>` there is a cast.
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'yield', 'await', 'typeof', 'case', 'throw', 'void', 'in', 'of']);

// The names declared as `type Name = Brand<...>`, plus every name in BRAND_OWNERS.
function brandedTypeNames(fileTokens: readonly (readonly Token[])[]): Set<string> {
  const names = new Set(Object.keys(BRAND_OWNERS));
  for (const tokens of fileTokens) {
    tokens.forEach((token, index) => {
      const name = tokens[index + 1];
      if (isIdentifier(token, 'type') && name?.kind === 'identifier'
        && isPunctuator(tokens[index + 2], '=') && isIdentifier(tokens[index + 3], 'Brand')) names.add(name.text);
    });
  }
  return names;
}

// The brand a call such as brand<string, 'SafeText'>(value) applies: the last string among its
// type arguments, or undefined when the brand is a type parameter.
function brandCallName(tokens: readonly Token[], openIndex: number): string | undefined {
  let depth = 0;
  let name: string | undefined;
  for (let index = openIndex; index < tokens.length; index++) {
    const token = tokens[index];
    if (isPunctuator(token, '<')) depth += 1;
    // A ">" straight after "=" closes an arrow in a function type, not the type arguments.
    else if (isPunctuator(token, '>') && !isPunctuator(tokens[index - 1], '=')) depth -= 1;
    else if (token?.kind === 'string' && depth === 1) name = token.text;
    if (depth === 0) return name;
  }
  return undefined;
}

type BrandCreation = { readonly name: string; readonly line: number; readonly how: string };

function brandCreations(tokens: readonly Token[], brands: ReadonlySet<string>): BrandCreation[] {
  const found: BrandCreation[] = [];
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    // `value as Name`, `value as unknown as Name`, `value as readonly Name[]`
    if (isIdentifier(token, 'as') && !isPunctuator(previous, '.')) {
      let next = index + 1;
      while (isIdentifier(tokens[next], 'unknown') && isIdentifier(tokens[next + 1], 'as')) next += 2;
      if (isIdentifier(tokens[next], 'readonly')) next += 1;
      const target = tokens[next];
      if (target?.kind === 'identifier' && brands.has(target.text)) found.push({ name: target.text, line: token.line, how: 'a cast' });
    }
    // `<Name>value`: an angle bracket where an expression starts, unlike the type argument in `Promise<Name>`.
    if (isPunctuator(token, '<') && isPunctuator(tokens[index + 2], '>')) {
      const target = tokens[index + 1];
      const startsExpression = previous === undefined
        || (previous.kind === 'punctuator' && ![')', ']', '>', '.'].includes(previous.text))
        || (previous.kind === 'identifier' && KEYWORDS_BEFORE_EXPRESSION.has(previous.text));
      if (startsExpression && target?.kind === 'identifier' && brands.has(target.text)) {
        found.push({ name: target.text, line: token.line, how: 'an angle-bracket cast' });
      }
    }
    // brand<Value, 'Name'>(value): the engine's helper that applies a brand.
    if (isIdentifier(token, 'brand') && isPunctuator(tokens[index + 1], '<')) {
      const name = brandCallName(tokens, index + 1);
      if (name !== undefined) found.push({ name, line: token.line, how: 'brand()' });
    }
  });
  return found;
}

export function checkBrandedCasts(root: string): string[] {
  const files = listSourceFiles(root).map((path) => ({ path, tokens: codeTokens(readFileSync(join(root, path), 'utf8')) }));
  const brands = brandedTypeNames(files.filter((file) => file.path.startsWith('packages/')).map((file) => file.tokens));
  const problems: string[] = [];
  for (const file of files) {
    for (const creation of brandCreations(file.tokens, brands)) {
      const owners = BRAND_OWNERS[creation.name] ?? [];
      if (owners.includes(file.path)) continue;
      const allowed = owners.length === 0 ? 'no module owns it yet; list its parser in BRAND_OWNERS' : `only ${owners.join(', ')} may create one`;
      const why = ACTOR_BRANDS.has(creation.name) ? ', which would let a caller choose its own actor' : '';
      problems.push(`${file.path}:${creation.line} creates the branded type ${creation.name} with ${creation.how}${why}; ${allowed}`);
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('branded-type check', checkBrandedCasts(process.cwd()));
