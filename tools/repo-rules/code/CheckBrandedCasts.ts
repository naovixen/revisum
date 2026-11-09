// Keeps branded types honest. A value of a branded type, such as SafeText or Plan, means "checked
// by its owning parser", so only that module may create one. This check fails, naming the file,
// when code elsewhere in packages/ or tools/ creates one by a cast (`as SafeText`,
// `as unknown as SafeText`, `<SafeText>value`, or a union or wrapper holding the brand, such as
// `as undefined | SafeText` or `as Readonly<SafeText>`), by annotating what JSON.parse returns
// (`const text: SafeText = JSON.parse(input)`, which needs no cast) or by the engine's brand() helper.
//
// The same rule keeps DerivedActor, the actor recorded on every audit event, out of callers' hands:
// only the engine's actor module and the approval verifier may build one, so no caller can choose
// its own actor type. An Approval, likewise, comes only from the approval verifier.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from '../naming/LintRepository.ts';
import { codeTokens, isIdentifier, isPunctuator, listSourceFiles } from '../ListSourceFiles.ts';
import { reportProblems } from '../ReadWorkspacePackages.ts';
import { TokenKind } from '../naming/LintRepository.ts';

const PLAN_PARSE = 'packages/engine/src/plan/parse';
const PLAN_PARSER = `${PLAN_PARSE}/PlanParser.ts`;
const PLAN_ENVELOPE = `${PLAN_PARSE}/ReadPlanData.ts`;
const PLAN_URLS = `${PLAN_PARSE}/text/ReadUrl.ts`;
const PLAN_CRITERIA = `${PLAN_PARSE}/text/ReadCriterionId.ts`;
const PLAN_DECLARED_NAMES = `${PLAN_PARSE}/declarations/ReadDeclared.ts`;
const PLAN_REMEMBERED_FIELDS = `${PLAN_PARSE}/declarations/ReadRememberedFields.ts`;
const PLAN_SCRIPTS = `${PLAN_PARSE}/declarations/ReadScriptChoice.ts`;
const PLAN_CAPTURES = `${PLAN_PARSE}/steps/EvidenceStepReaders.ts`;
const PLAN_DOWNLOADS = `${PLAN_PARSE}/steps/DownloadStepReaders.ts`;
const PROJECT_PARSER = 'packages/engine/src/project/ParseProject.ts';
const ACTOR_MODULE = 'packages/engine/src/approval/DeriveActor.ts';
const APPROVAL_VERIFIER = 'packages/engine/src/approval/ApprovalVerifier.ts';
const TRUSTED_PROJECT_LOADER = 'packages/engine/src/project/TrustedProject.ts';
const CALL_DECLARATIONS = 'packages/engine/src/project/ReadCallDeclarations.ts';
const EVIDENCE_DECLARATIONS = 'packages/engine/src/project/ReadEvidenceMode.ts';
const EVIDENCE_RESULT = 'packages/engine/src/evidence/EvidenceResult.ts';
const UNSAFE_FEATURE_DECLARATIONS = 'packages/engine/src/project/ReadUnsafeFeatures.ts';

// Each branded type, and the only files that may create a value of it. A branded type declared in
// packages/ but missing here is still checked: it has no owner, so any cast to it fails until its
// owning parser is listed.
export const BRAND_OWNERS: Readonly<Record<string, readonly string[]>> = {
  // The generic brand: only the engine's brand() helper casts to it.
  Brand: ['packages/engine/src/foundation/Brand.ts'],
  SafeText: ['packages/engine/src/plan/parse/ReadRecord.ts', 'packages/engine/src/plan/ReadUnscannedText.ts'],
  // A path template resolves to a path on the run's base URL once its values are known.
  AllowedUrl: [PLAN_URLS, 'packages/engine/src/run/values/RunValues.ts'],
  CaptureName: [PLAN_CAPTURES],
  // A download name is plain text the plan parser checks; it is never a path.
  DownloadName: [PLAN_DOWNLOADS],
  FeatureId: [PLAN_ENVELOPE],
  Plan: [PLAN_PARSER],
  // A suite's criterion annotations name criteria by the same rule as a plan.
  CriterionId: [PLAN_CRITERIA, EVIDENCE_RESULT],
  ValueName: ['packages/engine/src/plan/parse/declarations/ReadPlanClock.ts'],
  // An empty proxy server would send a session's traffic direct.
  ProxyServer: ['packages/driver-cdp/src/capabilities/SessionEgress.ts'],
  Project: [PROJECT_PARSER],
  SecretName: [PROJECT_PARSER],
  FixtureName: [PROJECT_PARSER],
  TestIdAttribute: [PROJECT_PARSER],
  EmailDomain: [PROJECT_PARSER],
  AiText: ['packages/engine/src/drafting/AiText.ts'],
  TargetId: [PROJECT_PARSER],
  AdapterId: [PROJECT_PARSER],
  Locale: [PROJECT_PARSER],
  TimeZone: [PROJECT_PARSER],
  PlannerUrl: [PROJECT_PARSER],
  // In contracts, because the engine and the runner, which may not import each other, both read origins.
  Origin: ['packages/contracts/src/foundation/ParseOrigin.ts'],
  ProxyRules: ['packages/runner/src/egress-proxy/rules/ParseProxyRules.ts'],
  // A workload request is read once, before any container starts.
  CheckedWorkloadRequest: ['packages/runner/src/workload/CheckWorkloadRequest.ts'],
  // In contracts, because a runner's handle takes it; only the runner reads one.
  VariableName: ['packages/runner/src/containers/ReadVariableName.ts'],
  // A run's base URL is read where it enters, or taken from an origin the project parser read.
  BaseUrl: ['packages/engine/src/project/ParseBaseUrl.ts'],
  // Declared services and calls are read with the project; a plan names a call and its fields by
  // the names the declarations gave them.
  ServiceName: [CALL_DECLARATIONS],
  CallName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES],
  // A database command's argument vector names its declared parameters.
  ParameterName: [CALL_DECLARATIONS, UNSAFE_FEATURE_DECLARATIONS],
  FieldName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES, PLAN_REMEMBERED_FIELDS],
  JsonPointer: [CALL_DECLARATIONS],
  // Stubs, observed requests and storage entries are named by the same declaration-section reader
  // as calls; a plan refers to them by those names.
  StubName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES],
  RequestName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES],
  StorageEntryName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES],
  // Evidence mode: a suite and its image are named in the project file; a decoded report and a
  // test's id come only from the report decoder and the result built from it.
  SuiteName: [EVIDENCE_DECLARATIONS],
  // The isolated runner reads its own run image's id back from Docker.
  ImageDigest: [EVIDENCE_DECLARATIONS, 'packages/runner/src/image/RunImage.ts'],
  // The egress proxy's targets are made bare once, where they are parsed.
  BareHost: ['packages/runner/src/egress-proxy/addresses/BareHost.ts'],
  SuiteReport: ['packages/engine/src/evidence/SuiteReport.ts'],
  SuiteTrace: ['packages/engine/src/evidence/ParseSuiteTrace.ts'],
  // Unsafe plan features: page scripts and database commands are named by the declaration-section
  // reader, and a plan refers to them by those names; only the plan parser reads an inline
  // script's source.
  ScriptName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES],
  CommandName: [CALL_DECLARATIONS, PLAN_DECLARED_NAMES],
  ScriptSource: [PLAN_SCRIPTS],
  SuiteTestId: [EVIDENCE_RESULT],
  ValidReport: ['packages/report/src/model/ParseReportInput.ts'],
  ActorId: [ACTOR_MODULE],
  DerivedActor: [ACTOR_MODULE, APPROVAL_VERIFIER],
  Approval: [APPROVAL_VERIFIER],
  TrustedProject: [TRUSTED_PROJECT_LOADER],
  // Not declared with Brand (its own key keeps it a narrower Plan), so it is listed by name.
  Authorised: ['packages/engine/src/policy/PolicyGate.ts'],
};
const ACTOR_BRANDS = new Set(['ActorId', 'DerivedActor']);

// After these words an angle bracket starts an expression, so `<Name>` there is a cast.
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'yield', 'await', 'typeof', 'case', 'throw', 'void', 'in', 'of']);
// These lead a type without being one.
const WORDS_BEFORE_A_TYPE = new Set(['readonly', 'keyof', 'typeof', 'unique', 'infer', 'new', 'abstract']);
const TYPE_BRACKETS: ReadonlyMap<string, string> = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

// The names declared as `type Name = Brand<...>`, plus every name in BRAND_OWNERS.
function brandedTypeNames(fileTokens: readonly (readonly Token[])[]): Set<string> {
  const names = new Set(Object.keys(BRAND_OWNERS));
  for (const tokens of fileTokens) {
    tokens.forEach((token, index) => {
      const name = tokens[index + 1];
      if (isIdentifier(token, 'type') && name?.kind === TokenKind.Identifier
        && isPunctuator(tokens[index + 2], '=') && isIdentifier(tokens[index + 3], 'Brand')) {names.add(name.text);}
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
    if (isPunctuator(token, '<')) {depth += 1;}
    // A ">" straight after "=" closes an arrow in a function type, not the type arguments.
    else if (isPunctuator(token, '>') && !isPunctuator(tokens[index - 1], '=')) {depth -= 1;}
    else if (token?.kind === TokenKind.String && depth === 1) {name = token.text;}
    if (depth === 0) {return name;}
  }
  return undefined;
}

// The tokenizer splits "=>" into "=" and ">".
const isArrow = (tokens: readonly Token[], index: number): boolean =>
  isPunctuator(tokens[index], '=') && isPunctuator(tokens[index + 1], '>');

// True when the token at `index`, just after a whole type, carries that type on: `A | B`, `A & B`,
// `a.B`, `A<B>` or `A[]`. An array type's "[" must share a line with what it follows, and "||" or
// "&&" is a logical operator, not a union or an intersection.
function continuesType(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index];
  if (isPunctuator(token, '|') || isPunctuator(token, '&')) {
    return !isPunctuator(tokens[index + 1], token?.text ?? '');
  }
  if (isPunctuator(token, '[')) {
    return token?.line === tokens[index - 1]?.line;
  }
  return isPunctuator(token, '.') || isPunctuator(token, '<');
}

type TypeRead = {
  // The type names it holds, leaving out a property's own name and what `keyof` or `typeof` takes.
  readonly names: readonly string[];
  // The index just past the type.
  readonly end: number;
};

// Reads the type starting at `start`. A function type's parameters are left out of its names: a
// value of `(plan: Plan) => void` holds no Plan.
function readType(tokens: readonly Token[], start: number): TypeRead {
  const names: string[] = [];
  const open: { readonly closer: string; readonly namesBefore: number }[] = [];
  let isTypeExpected = true;
  let index = start;
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    const closer = TYPE_BRACKETS.get(token?.text ?? '');
    if (token === undefined) {
      break;
    }
    if (isArrow(tokens, index) && isPunctuator(tokens[index - 1], ')')) {
      index += 1;
      isTypeExpected = true;
    } else if (open.length === 0 && !isTypeExpected && !continuesType(tokens, index)) {
      break;
    } else if (token.kind === TokenKind.Punctuator && closer !== undefined) {
      open.push({ closer, namesBefore: names.length });
      isTypeExpected = true;
    } else if (token.kind === TokenKind.Punctuator && [...TYPE_BRACKETS.values()].includes(token.text)) {
      const closed = open.pop();
      if (closed?.closer !== token.text) {
        break;
      }
      if (token.text === ')' && isArrow(tokens, index + 1)) {
        names.splice(closed.namesBefore);
      }
      isTypeExpected = false;
    } else if (token.kind === TokenKind.Punctuator) {
      if (token.text === ';' && open.at(-1)?.closer !== '}') {
        break;
      }
      isTypeExpected = true;
    } else if (token.kind !== TokenKind.Identifier || !WORDS_BEFORE_A_TYPE.has(token.text)) {
      const previous = tokens[index - 1];
      const isQueried = isIdentifier(previous, 'keyof') || isIdentifier(previous, 'typeof');
      const isPropertyName = isPunctuator(tokens[index + 1], ':') || (isPunctuator(tokens[index + 1], '?') && isPunctuator(tokens[index + 2], ':'));
      if (token.kind === TokenKind.Identifier && !isQueried && !isPropertyName) {
        names.push(token.text);
      }
      isTypeExpected = false;
    }
  }
  return { names, end: index };
}

// `const plan: Plan = JSON.parse(text)`: JSON.parse returns any, so this needs no cast at all. True
// when the ":" at `index` starts such an annotation, on a name or a destructuring pattern.
function annotatesWhatJsonParseReturns(tokens: readonly Token[], index: number, end: number): boolean {
  const annotated = tokens[index - 1];
  const isAnnotation = annotated?.kind === TokenKind.Identifier || isPunctuator(annotated, '}') || isPunctuator(annotated, ']');
  return isAnnotation && isPunctuator(tokens[end], '=')
    && isIdentifier(tokens[end + 1], 'JSON') && isPunctuator(tokens[end + 2], '.') && isIdentifier(tokens[end + 3], 'parse');
}

type BrandCreation = { readonly name: string; readonly line: number; readonly how: string };

function brandCreations(tokens: readonly Token[], brands: ReadonlySet<string>): BrandCreation[] {
  const found: BrandCreation[] = [];
  const addBrandsIn = (type: TypeRead, line: number, how: string): void => {
    for (const name of new Set(type.names)) {
      if (brands.has(name)) {
        found.push({ name, line, how });
      }
    }
  };
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    // `value as Name`, `value as readonly Name[]`, `value as undefined | Name`, `value as Readonly<Name>`
    if (isIdentifier(token, 'as') && !isPunctuator(previous, '.')) {
      addBrandsIn(readType(tokens, index + 1), token.line, 'a cast');
    }
    if (isPunctuator(token, ':')) {
      const annotation = readType(tokens, index + 1);
      if (annotatesWhatJsonParseReturns(tokens, index, annotation.end)) {
        addBrandsIn(annotation, token.line, 'an annotation on what JSON.parse returns');
      }
    }
    // `<Name>value`: an angle bracket where an expression starts, unlike the type argument in `Promise<Name>`.
    if (isPunctuator(token, '<')) {
      // After an arrow an expression starts.
      const isAfterArrow = isPunctuator(previous, '>') && isPunctuator(tokens[index - 2], '=');
      const isExpressionStart = previous === undefined || isAfterArrow
        || (previous.kind === TokenKind.Punctuator && ![')', ']', '>', '.'].includes(previous.text))
        || (previous.kind === TokenKind.Identifier && KEYWORDS_BEFORE_EXPRESSION.has(previous.text));
      // `<T extends Name>(…) => …` and `<T, U>(…) => …` declare type parameters; they make no value.
      const isTypeParameterList = isIdentifier(tokens[index + 2], 'extends') || isPunctuator(tokens[index + 2], ',') || isPunctuator(tokens[index + 2], '=');
      if (isExpressionStart && !isTypeParameterList) {
        addBrandsIn(readType(tokens, index), token.line, 'an angle-bracket cast');
      }
    }
    // brand<Value, 'Name'>(value): the engine's helper that applies a brand.
    if (isIdentifier(token, 'brand') && isPunctuator(tokens[index + 1], '<')) {
      const name = brandCallName(tokens, index + 1);
      if (name !== undefined) {found.push({ name, line: token.line, how: 'brand()' });}
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
      if (owners.includes(file.path)) {continue;}
      const allowed = owners.length === 0 ? 'no module owns it yet; list its parser in BRAND_OWNERS' : `only ${owners.join(', ')} may create one`;
      const why = ACTOR_BRANDS.has(creation.name) ? ', which would let a caller choose its own actor' : '';
      problems.push(`${file.path}:${creation.line} creates the branded type ${creation.name} with ${creation.how}${why}; ${allowed}`);
    }
  }
  return problems;
}

if (import.meta.main) {process.exitCode = reportProblems('branded-type check', checkBrandedCasts(process.cwd()));}
