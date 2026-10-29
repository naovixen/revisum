// The readable plan format: a plain-text `.plan` file, read into plain JSON for the one plan parser
// and written back from a parsed Plan. Reading never builds a Plan and never decides what a plan
// may do: it turns lines into JSON fields, and the parser alone accepts or refuses the result.
//
// A file is headers, then steps, then an optional `Clean up:` block. Indentation is two spaces per
// block level. Blank lines and comment lines (starting with #) may stand anywhere; comments are
// dropped with a warning. A check takes the criterion id of the `Criterion:` line before it, in
// reading order. A step line holding an unsafe construct starts with the mark `Unsafe:`, and no
// other line does. An inline script's source follows its statement in a source block, one quoted
// script line per line. Errors give a line and a column and never repeat the text.
//
// The writer writes exactly one text for a plan: LF line ends, a final newline, the headers in a
// fixed order, a `Criterion:` line wherever the criterion id changes, and never `Origin:`.
// See docs/specs/SPEC-28-plan-authoring.md.
import { failure, success, type Plan, type Result, type SinkError, type StepType } from '@revisum/contracts';
import type { PlanLimits } from '../../project/project-parser.ts';
import type { PlanError, PlanErrorCode } from '../plan-decoders.ts';
import { CRITERION_FIELD, STEP_FIELDS } from '../plan-grammar.ts';
import {
  CLEANUP_LINE, CRITERION_LINE, HEADERS, STEP_STATEMENTS, UNSAFE_MARK, VALUES_LINE, VALUE_DEFINITION, needsUnsafeMark,
  type StatementBlock,
} from './plan-statements.ts';
import {
  SCRIPT_LINE, better, isRecord, notThisStatement, skipSpaces, wordAt, type TextErrorCode, type TextFailure, type TextPosition,
} from './text-syntax.ts';

export type { TextErrorCode, TextPosition } from './text-syntax.ts';

export type TextWarning = { readonly code: 'comment-dropped'; readonly position: TextPosition };

// Reading text gives plain JSON for the plan parser, the place each JSON path came from, and the
// warnings. It never gives a Plan.
export type TextReading = {
  readonly json: unknown;
  readonly positions: ReadonlyMap<string, TextPosition>;
  readonly warnings: readonly TextWarning[];
};

// Why a draft was refused, by the stage that refused it. Text errors and the parser's errors are
// placed by line and column (a JSON draft's parser errors have no lines); none repeats a value.
export type DraftError =
  | { readonly stage: 'text'; readonly code: TextErrorCode; readonly position: TextPosition }
  | { readonly stage: 'plan'; readonly code: PlanErrorCode; readonly path: string; readonly position: TextPosition | null }
  // A draft that claims a source only core itself can record.
  | { readonly stage: 'source'; readonly code: 'untrusted-source'; readonly position: null }
  // The audit sink did not record the submission, so the plan is not admitted.
  | { readonly stage: 'audit'; readonly code: SinkError['code']; readonly position: null };

type Fields = Record<string, unknown>;

// The JSON fields a statement does not hold itself: a check's criterion id comes from the
// Criterion: line before it, a frame's or second tab's steps from the block after it, and an
// inline script's source (script.inline.source) from its source block.
const STEPS_FIELD = 'steps';
const SCRIPT_FIELD = 'script';
const INLINE_FIELD = 'inline';
const SOURCE_FIELD = 'source';
const isCheck = (type: StepType): boolean => STEP_FIELDS[type].required.includes(CRITERION_FIELD);
const INDENT = '  ';
const LINE_START: TextPosition = { line: 1, column: 1 };
// Script lines are joined with LF, and a source is split at LF to write them: one line each.
const SCRIPT_LINE_BREAK = '\n';

// What the lines of a block are read into.
type Block =
  | { readonly kind: 'top' }
  | { readonly kind: 'values'; readonly values: Fields }
  | { readonly kind: 'steps'; readonly steps: unknown[]; readonly path: string }
  // An inline script's source lines, joined into `inline.source`; `path` is the source's JSON path.
  | { readonly kind: 'source'; readonly lines: string[]; readonly inline: Fields; readonly path: string };

// Where the line's statement starts once its `Unsafe:` mark is passed over, or undefined when it
// has none. The mark is a grammar word, read in any case.
function afterMark(line: string, indent: number): number | undefined {
  const { word, end } = wordAt(line, indent);
  return word.toLowerCase() === UNSAFE_MARK.toLowerCase() ? end : undefined;
}

// A step's inline script, copied so its source can be added from the source block, or undefined
// for a step that runs no inline script.
function inlineScriptOf(step: Fields): Fields | undefined {
  const script = step[SCRIPT_FIELD];
  if (!isRecord(script) || !isRecord(script[INLINE_FIELD])) return undefined;
  const inline: Fields = { ...script[INLINE_FIELD] };
  step[SCRIPT_FIELD] = { ...script, [INLINE_FIELD]: inline };
  return inline;
}

// A refused line that opens a block whose kind its words still show: an inline script's source
// lines are read as script lines, so their own errors are reported rather than unknown-statement.
const INLINE_STATEMENT_START = /^\s*(run|expect)\s+inline\b/i;

// Reads readable text into plain JSON for the plan parser. Pure: it never builds a Plan.
export function readPlanText(text: string, limits: PlanLimits): Result<TextReading, readonly DraftError[]> {
  // Text larger than any plan may be is refused whole, before any line is read.
  if (new TextEncoder().encode(text).length > limits.maximumPlanBytes) return failure([{ stage: 'text', code: 'too-large', position: LINE_START }]);

  const errors: DraftError[] = [];
  const warnings: TextWarning[] = [];
  const positions = new Map<string, TextPosition>([['$', LINE_START]]);
  const headerFields: Fields = {};
  const steps: unknown[] = [];
  let values: Fields | undefined;
  let cleanup: unknown[] | undefined;
  let origin: string | undefined;
  // Headers come before the first step, and nothing follows the Clean up: block.
  let phase: 'headers' | 'steps' | 'cleanup' = 'headers';
  let criterion: { readonly id: unknown; readonly position: TextPosition } | undefined;
  const seenHeaders = new Set<string>();
  // The open blocks, one per indentation level.
  const blocks: Block[] = [{ kind: 'top' }];

  const at = (line: number): TextPosition => ({ line, column: 1 });
  const refuse = (code: TextErrorCode, line: number, column: number): void => { errors.push({ stage: 'text', code, position: { line, column } }); };
  const refuseFor = (found: TextFailure, line: number): void => refuse(found.code, line, found.column);

  // A header is placed once, before the first step.
  function placeHeader(name: string, line: number): boolean {
    if (phase !== 'headers') { refuse('unknown-statement', line, 1); return false; }
    if (seenHeaders.has(name)) { refuse('duplicate-header', line, 1); return false; }
    seenHeaders.add(name);
    return true;
  }

  function setHeaderField(path: readonly string[], value: unknown, line: number): void {
    let holder = headerFields;
    path.forEach((key, depth) => {
      const jsonPath = `$.${path.slice(0, depth + 1).join('.')}`;
      if (!positions.has(jsonPath)) positions.set(jsonPath, at(line));
      if (depth === path.length - 1) { holder[key] = value; return; }
      const inner = holder[key];
      const next: Fields = isRecord(inner) ? { ...inner } : {};
      holder[key] = next;
      holder = next;
    });
  }

  // Only a step line may carry the Unsafe: mark; any other line that reads with one is refused.
  const refuseMark = (marked: boolean, number: number): void => { if (marked) refuse('unneeded-unsafe-mark', number, 1); };

  // A Criterion: line, or a step, into `target`. True when it was a step. A step line's mark must
  // match what its statement holds, as needsUnsafeMark decides from the words read.
  function readStepLine(target: unknown[], path: string, line: string, indent: number, number: number, marked: boolean, earlier?: TextFailure): boolean {
    const criterionLine = CRITERION_LINE.read(line, indent);
    if (criterionLine.ok) {
      refuseMark(marked, number);
      criterion = { id: isRecord(criterionLine.value) ? criterionLine.value['criterion'] : undefined, position: at(number) };
      return false;
    }
    let found = better(earlier, criterionLine.failure);
    // A line ending with ":" may open a block: a frame's or second tab's steps, or a source block.
    const blockLine = line.endsWith(':') ? line.slice(0, -1).replace(/ +$/, '') : undefined;
    for (const { type, syntax, opens } of STEP_STATEMENTS) {
      const reading = opens !== undefined ? (blockLine === undefined ? undefined : syntax.read(blockLine, indent)) : syntax.read(line, indent);
      if (reading === undefined) continue;
      if (!reading.ok) { found = better(found, reading.failure); continue; }
      const step: Fields = isRecord(reading.value) ? { ...reading.value } : {};
      const needed = needsUnsafeMark(step);
      if (needed && !marked) refuse('missing-unsafe-mark', number, 1);
      if (!needed && marked) refuse('unneeded-unsafe-mark', number, 1);
      const stepPath = `${path}[${target.length}]`;
      positions.set(stepPath, at(number));
      // With an Origin: header, a path in Go to or In new tab at is resolved against it.
      const url = step['url'];
      if (origin !== undefined && typeof url === 'string' && url.startsWith('/')) step['url'] = `${origin.replace(/\/+$/, '')}${url}`;
      if (isCheck(type)) {
        if (criterion === undefined) refuse('no-criterion', number, 1);
        else { step[CRITERION_FIELD] = criterion.id; positions.set(`${stepPath}.${CRITERION_FIELD}`, criterion.position); }
      }
      if (opens === 'steps') {
        const nested: unknown[] = [];
        step[STEPS_FIELD] = nested;
        blocks.push({ kind: 'steps', steps: nested, path: `${stepPath}.${STEPS_FIELD}` });
      }
      if (opens === 'source') {
        const sourcePath = `${stepPath}.${SCRIPT_FIELD}.${INLINE_FIELD}.${SOURCE_FIELD}`;
        blocks.push({ kind: 'source', lines: [], inline: inlineScriptOf(step) ?? {}, path: sourcePath });
      }
      target.push(step);
      return true;
    }
    refuseFor(found ?? notThisStatement(indent), number);
    // A refused block's lines are still read, into nothing, so their own errors are reported too.
    if (blockLine !== undefined) {
      const refusedPath = `${path}[${target.length}]`;
      blocks.push(INLINE_STATEMENT_START.test(blockLine)
        ? { kind: 'source', lines: [], inline: {}, path: refusedPath }
        : { kind: 'steps', steps: [], path: `${refusedPath}.${STEPS_FIELD}` });
    }
    return false;
  }

  function readTopLine(line: string, indent: number, number: number, marked: boolean): void {
    let found: TextFailure | undefined;
    for (const header of HEADERS) {
      const reading = header.line.read(line, indent);
      if (!reading.ok) { found = better(found, reading.failure); continue; }
      refuseMark(marked, number);
      if (!placeHeader(header.name, number)) return;
      const value = isRecord(reading.value) ? reading.value['value'] : undefined;
      if (header.path !== null) setHeaderField(header.path, value, number);
      else origin = typeof value === 'string' ? value : undefined;
      return;
    }
    const valuesLine = VALUES_LINE.read(line, indent);
    if (valuesLine.ok) {
      refuseMark(marked, number);
      if (!placeHeader('Values:', number)) return;
      values = {};
      positions.set('$.values', at(number));
      blocks.push({ kind: 'values', values });
      return;
    }
    const cleanupLine = CLEANUP_LINE.read(line, indent);
    if (cleanupLine.ok && phase !== 'cleanup') {
      refuseMark(marked, number);
      cleanup = [];
      phase = 'cleanup';
      positions.set('$.cleanup', at(number));
      blocks.push({ kind: 'steps', steps: cleanup, path: '$.cleanup' });
      return;
    }
    if (phase === 'cleanup') { refuse('unknown-statement', number, 1); return; }
    found = better(found, better(valuesLine.ok ? undefined : valuesLine.failure, cleanupLine.ok ? undefined : cleanupLine.failure));
    if (readStepLine(steps, '$.steps', line, indent, number, marked, found)) phase = 'steps';
  }

  // One script line of a source block: quoted text and nothing else, a mark included. Anything
  // else is bad-string at its first character outside the quotes.
  function readScriptLine(block: Extract<Block, { kind: 'source' }>, line: string, indent: number, number: number): void {
    const reading = SCRIPT_LINE.read(line, indent);
    if (!reading.ok) { refuse('bad-string', number, reading.failure.code === 'bad-string' ? reading.failure.column : indent + 1); return; }
    if (reading.next < line.length) { refuse('bad-string', number, reading.next + 1); return; }
    if (block.lines.length === 0) positions.set(block.path, at(number));
    block.lines.push(typeof reading.value === 'string' ? reading.value : '');
    block.inline[SOURCE_FIELD] = block.lines.join(SCRIPT_LINE_BREAK);
  }

  function readValueLine(into: Fields, line: string, indent: number, number: number, marked: boolean): void {
    const reading = VALUE_DEFINITION.read(line, indent);
    if (!reading.ok) { refuseFor(reading.failure, number); return; }
    refuseMark(marked, number);
    const { name, value, nameColumn } = reading.value;
    // JSON cannot hold one name twice.
    if (Object.hasOwn(into, name)) { refuse('duplicate-key', number, nameColumn); return; }
    into[name] = value;
    positions.set(`$.values.${name}`, at(number));
  }

  // Windows editors may write a byte-order mark and CRLF line ends; spaces at a line's end are ignored.
  const lines = text.replace(/^﻿/, '').split('\n').map((line) => line.replace(/\r$/, '').replace(/ +$/, ''));
  lines.forEach((line, index) => {
    const number = index + 1;
    if (line.trim() === '') return;
    if (/^\s*#/.test(line)) { warnings.push({ code: 'comment-dropped', position: at(number) }); return; }
    const indent = skipSpaces(line, 0);
    const depth = indent / 2;
    // Spaces only, two per level, and no deeper than the blocks open.
    if (/\s/.test(line[indent] ?? '') || indent % 2 !== 0 || depth >= blocks.length) { refuse('bad-indent', number, 1); return; }
    blocks.length = depth + 1;
    const block = blocks[depth] ?? { kind: 'top' };
    if (block.kind === 'source') { readScriptLine(block, line, indent, number); return; }
    // The mark is passed over as spaces, so every column after it stays where it is in the text.
    const statementStart = afterMark(line, indent);
    const marked = statementStart !== undefined;
    const statement = marked ? `${line.slice(0, indent)}${' '.repeat(statementStart - indent)}${line.slice(statementStart)}` : line;
    switch (block.kind) {
      case 'top': readTopLine(statement, indent, number, marked); return;
      case 'values': readValueLine(block.values, statement, indent, number, marked); return;
      case 'steps': readStepLine(block.steps, block.path, statement, indent, number, marked); return;
    }
  });

  for (const header of HEADERS) if (header.required && !seenHeaders.has(header.name)) refuse('missing-header', LINE_START.line, LINE_START.column);
  if (errors.length > 0) return failure(errors);
  const json: Fields = {
    ...headerFields, ...(values === undefined ? {} : { values }), steps, ...(cleanup === undefined ? {} : { cleanup }),
  };
  return success({ json, positions, warnings });
}

// The place of a JSON path in the text it was read from: the path's own, or else its nearest
// enclosing path's, so a parser error is placed on the line of the statement it is about.
function positionOf(path: string, positions: ReadonlyMap<string, TextPosition>): TextPosition | null {
  for (let current = path; ; ) {
    const found = positions.get(current);
    if (found !== undefined) return found;
    const cut = Math.max(current.lastIndexOf('.'), current.lastIndexOf('['));
    if (cut <= 0) return positions.get('$') ?? null;
    current = current.slice(0, cut);
  }
}

// The parser's errors, placed on the lines of the text they came from, or unplaced for JSON.
export const placedPlanErrors = (errors: readonly PlanError[], positions: ReadonlyMap<string, TextPosition> | null): DraftError[] =>
  errors.map(({ code, path }) => ({ stage: 'plan', code, path, position: positions === null ? null : positionOf(path, positions) }));

// ---- Writing --------------------------------------------------------------------------------------

const valueAt = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((holder, key) => (isRecord(holder) ? holder[key] : undefined), value);

// Why a plan has no readable text: it holds a construct the readable format has no form for, at
// that construct's path, so it stays JSON. Every construct of plan language 1.3 has a form, so no
// plan gets this today; it is kept for a construct that reaches the language before its form does.
export type NoReadableForm = { readonly code: Extract<TextErrorCode, 'no-readable-form'>; readonly path: string };

// The canonical text of a parsed plan. Every construct of the language has a readable form, the
// unsafe features included, so it always gives writePlanText's text. Pure.
export function readablePlanText(plan: Plan): Result<string, NoReadableForm> {
  return success(writePlanText(plan));
}

// A step's fields without its inline script's source, which is written as the source block after
// the statement, and the source; the fields as they are for any other step.
function withoutSource(fields: Fields): { readonly statement: Fields; readonly source: unknown } {
  const script = fields[SCRIPT_FIELD];
  if (!isRecord(script) || !isRecord(script[INLINE_FIELD])) return { statement: fields, source: undefined };
  const { [SOURCE_FIELD]: source, ...inline } = script[INLINE_FIELD];
  return { statement: { ...fields, [SCRIPT_FIELD]: { ...script, [INLINE_FIELD]: inline } }, source };
}

// The canonical text of a parsed plan. Pure.
export function writePlanText(plan: Plan): string {
  const lines: string[] = [];
  const put = (depth: number, text: string | undefined): void => {
    // Every construct of the language has a readable form, so this is a broken grammar.
    if (text === undefined) throw new Error('the readable grammar has no form for part of this plan');
    lines.push(`${INDENT.repeat(depth)}${text}`);
  };
  for (const header of HEADERS) {
    const value = header.path === null ? undefined : valueAt(plan, header.path);
    if (value !== undefined) put(0, header.line.write({ value }));
  }
  if (plan.values !== undefined) {
    put(0, VALUES_LINE.write({}));
    for (const [name, value] of Object.entries(plan.values)) put(1, VALUE_DEFINITION.write(name, value));
  }
  let criterion: unknown;
  const writeSteps = (steps: readonly unknown[], depth: number): void => {
    for (const step of steps) {
      const fields: Fields = isRecord(step) ? { ...step } : {};
      const id = fields[CRITERION_FIELD];
      const nested = fields[STEPS_FIELD];
      delete fields[CRITERION_FIELD];
      delete fields[STEPS_FIELD];
      // The first of the step type's statements that has text for the step.
      let written: { readonly text: string; readonly opens: StatementBlock | undefined; readonly source: unknown } | undefined;
      let type: StepType | undefined;
      for (const candidate of STEP_STATEMENTS) {
        if (candidate.type !== fields['type']) continue;
        type = candidate.type;
        const { statement, source } = candidate.opens === 'source' ? withoutSource(fields) : { statement: fields, source: undefined };
        const text = candidate.syntax.write(statement);
        if (text !== undefined) { written = { text, opens: candidate.opens, source }; break; }
      }
      if (type === undefined || written === undefined) { put(depth, undefined); return; }
      if (isCheck(type) && id !== criterion) {
        put(depth, CRITERION_LINE.write({ criterion: id }));
        criterion = id;
      }
      const mark = needsUnsafeMark(fields) ? `${UNSAFE_MARK} ` : '';
      put(depth, `${mark}${written.text}${written.opens === undefined ? '' : ':'}`);
      if (written.opens === 'steps' && Array.isArray(nested)) writeSteps(nested, depth + 1);
      if (written.opens === 'source' && typeof written.source === 'string') {
        for (const scriptLine of written.source.split(SCRIPT_LINE_BREAK)) put(depth + 1, SCRIPT_LINE.write(scriptLine));
      }
    }
  };
  writeSteps(plan.steps, 0);
  if (plan.cleanup !== undefined) {
    put(0, CLEANUP_LINE.write({}));
    writeSteps(plan.cleanup, 1);
  }
  return `${lines.join('\n')}\n`;
}
