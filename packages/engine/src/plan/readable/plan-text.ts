// The readable plan format: a plain-text `.plan` file, read into plain JSON for the one plan parser
// and written back from a parsed Plan. Reading never builds a Plan and never decides what a plan
// may do: it turns lines into JSON fields, and the parser alone accepts or refuses the result.
//
// A file is headers, then steps, then an optional `Clean up:` block. Indentation is two spaces per
// block level. Blank lines and comment lines (starting with #) may stand anywhere; comments are
// dropped with a warning. A check takes the criterion id of the `Criterion:` line before it, in
// reading order. Errors give a line and a column and never repeat the text.
//
// The writer writes exactly one text for a plan: LF line ends, a final newline, the headers in a
// fixed order, a `Criterion:` line wherever the criterion id changes, and never `Origin:`.
// See docs/specs/SPEC-28-plan-authoring.md.
import { failure, success, type Plan, type Result, type SinkError, type StepType } from '@revisum/contracts';
import type { PlanLimits } from '../../project/project-parser.ts';
import type { PlanError, PlanErrorCode } from '../plan-decoders.ts';
import { CRITERION_FIELD, STEP_FIELDS, STEP_TYPES } from '../plan-grammar.ts';
import { unsafeConstructsOf } from '../unsafe-features.ts';
import { CLEANUP_LINE, CRITERION_LINE, HEADERS, STEP_STATEMENTS, VALUES_LINE, VALUE_DEFINITION } from './plan-statements.ts';
import { better, isRecord, notThisStatement, skipSpaces, type TextErrorCode, type TextFailure, type TextPosition } from './text-syntax.ts';

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
// Criterion: line before it, and a frame's or second tab's steps from the block after it.
const STEPS_FIELD = 'steps';
const isCheck = (type: StepType): boolean => STEP_FIELDS[type].required.includes(CRITERION_FIELD);
const opensBlock = (type: StepType): boolean => STEP_FIELDS[type].required.includes(STEPS_FIELD);
const INDENT = '  ';
const LINE_START: TextPosition = { line: 1, column: 1 };

// What the lines of a block are read into.
type Block =
  | { readonly kind: 'top' }
  | { readonly kind: 'values'; readonly values: Fields }
  | { readonly kind: 'steps'; readonly steps: unknown[]; readonly path: string };

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

  // A Criterion: line, or a step, into `target`. True when it was a step.
  function readStepLine(target: unknown[], path: string, line: string, indent: number, number: number, earlier?: TextFailure): boolean {
    const criterionLine = CRITERION_LINE.read(line, indent);
    if (criterionLine.ok) {
      criterion = { id: isRecord(criterionLine.value) ? criterionLine.value['criterion'] : undefined, position: at(number) };
      return false;
    }
    let found = better(earlier, criterionLine.failure);
    // A line ending with ":" may open a block: a frame or a second tab.
    const blockLine = line.endsWith(':') ? line.slice(0, -1).replace(/ +$/, '') : undefined;
    for (const { type, syntax } of STEP_STATEMENTS) {
      const reading = opensBlock(type) ? (blockLine === undefined ? undefined : syntax.read(blockLine, indent)) : syntax.read(line, indent);
      if (reading === undefined) continue;
      if (!reading.ok) { found = better(found, reading.failure); continue; }
      const step: Fields = isRecord(reading.value) ? { ...reading.value } : {};
      const stepPath = `${path}[${target.length}]`;
      positions.set(stepPath, at(number));
      // With an Origin: header, a path in Go to or In new tab at is resolved against it.
      const url = step['url'];
      if (origin !== undefined && typeof url === 'string' && url.startsWith('/')) step['url'] = `${origin.replace(/\/+$/, '')}${url}`;
      if (isCheck(type)) {
        if (criterion === undefined) refuse('no-criterion', number, 1);
        else { step[CRITERION_FIELD] = criterion.id; positions.set(`${stepPath}.${CRITERION_FIELD}`, criterion.position); }
      }
      if (opensBlock(type)) {
        const nested: unknown[] = [];
        step[STEPS_FIELD] = nested;
        blocks.push({ kind: 'steps', steps: nested, path: `${stepPath}.${STEPS_FIELD}` });
      }
      target.push(step);
      return true;
    }
    refuseFor(found ?? notThisStatement(indent), number);
    // A refused block's lines are still read, into nothing, so their own errors are reported too.
    if (blockLine !== undefined) blocks.push({ kind: 'steps', steps: [], path: `${path}[${target.length}].${STEPS_FIELD}` });
    return false;
  }

  function readTopLine(line: string, indent: number, number: number): void {
    let found: TextFailure | undefined;
    for (const header of HEADERS) {
      const reading = header.line.read(line, indent);
      if (!reading.ok) { found = better(found, reading.failure); continue; }
      if (!placeHeader(header.name, number)) return;
      const value = isRecord(reading.value) ? reading.value['value'] : undefined;
      if (header.path !== null) setHeaderField(header.path, value, number);
      else origin = typeof value === 'string' ? value : undefined;
      return;
    }
    const valuesLine = VALUES_LINE.read(line, indent);
    if (valuesLine.ok) {
      if (!placeHeader('Values:', number)) return;
      values = {};
      positions.set('$.values', at(number));
      blocks.push({ kind: 'values', values });
      return;
    }
    const cleanupLine = CLEANUP_LINE.read(line, indent);
    if (cleanupLine.ok && phase !== 'cleanup') {
      cleanup = [];
      phase = 'cleanup';
      positions.set('$.cleanup', at(number));
      blocks.push({ kind: 'steps', steps: cleanup, path: '$.cleanup' });
      return;
    }
    if (phase === 'cleanup') { refuse('unknown-statement', number, 1); return; }
    found = better(found, better(valuesLine.ok ? undefined : valuesLine.failure, cleanupLine.ok ? undefined : cleanupLine.failure));
    if (readStepLine(steps, '$.steps', line, indent, number, found)) phase = 'steps';
  }

  function readValueLine(into: Fields, line: string, indent: number, number: number): void {
    const reading = VALUE_DEFINITION.read(line, indent);
    if (!reading.ok) { refuseFor(reading.failure, number); return; }
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
    switch (block.kind) {
      case 'top': readTopLine(line, indent, number); return;
      case 'values': readValueLine(block.values, line, indent, number); return;
      case 'steps': readStepLine(block.steps, block.path, line, indent, number); return;
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
// that construct's path, so it stays JSON.
export type NoReadableForm = { readonly code: Extract<TextErrorCode, 'no-readable-form'>; readonly path: string };

// The canonical text of a parsed plan, or no-readable-form at the first construct the readable
// format has no form for: an unsafe plan feature, at the path of the field that names it. The one
// route to readable text for a plan that may hold one. Pure.
export function readablePlanText(plan: Plan): Result<string, NoReadableForm> {
  const first = unsafeConstructsOf(plan)[0];
  return first === undefined ? success(writePlanText(plan)) : failure({ code: 'no-readable-form', path: first.path });
}

// The canonical text of a parsed plan. Pure. A plan holding an unsafe feature has no readable form,
// so passing one is a programming error: a caller that may hold one uses readablePlanText.
export function writePlanText(plan: Plan): string {
  const lines: string[] = [];
  const put = (depth: number, text: string | undefined): void => {
    // Every construct of the closed language has a readable form, so this is a broken grammar or a
    // plan with an unsafe feature, which only readablePlanText may be given.
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
      const type = STEP_TYPES.find((candidate) => candidate === fields['type']);
      const statement = STEP_STATEMENTS.find((candidate) => candidate.type === type);
      if (type === undefined || statement === undefined) { put(depth, undefined); return; }
      const id = fields[CRITERION_FIELD];
      if (isCheck(type) && id !== criterion) {
        put(depth, CRITERION_LINE.write({ criterion: id }));
        criterion = id;
      }
      const nested = fields[STEPS_FIELD];
      delete fields[CRITERION_FIELD];
      delete fields[STEPS_FIELD];
      const text = statement.syntax.write(fields);
      put(depth, opensBlock(type) && text !== undefined ? `${text}:` : text);
      if (opensBlock(type) && Array.isArray(nested)) writeSteps(nested, depth + 1);
    }
  };
  writeSteps(plan.steps, 0);
  if (plan.cleanup !== undefined) {
    put(0, CLEANUP_LINE.write({}));
    writeSteps(plan.cleanup, 1);
  }
  return `${lines.join('\n')}\n`;
}
