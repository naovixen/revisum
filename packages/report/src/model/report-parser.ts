// parseReportInput and parseHistory: the only way to get typed values from report data. Input is
// unknown; the output is a typed value or a list of { path, code }. They never throw, and unknown
// keys are rejected, so a typo or an injected field cannot slip through.
import { isHex64, isId, wordCount } from '../text-safety.ts';
import {
  HISTORY_SCHEMA, MAXIMUM_CAPTION_WORDS, REPORT_INPUT_SCHEMA, SEVERITIES,
  type AcceptanceCriterion, type Criterion, type EvidenceReference, type Exchange, type Finding, type History,
  type HistoryPeriod, type ImageMeta, type Parsed, type PixelBox, type PlanStep, type ReportError, type ReportInput, type ReportKind, type RunInfo,
  type Severity, type ValidReport, type Verdict,
} from './report-model.ts';

type Fields = Readonly<Record<string, unknown>>;
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const KINDS: readonly ReportKind[] = ['a11y', 'functional', 'api'];
const VERDICTS: readonly Verdict[] = ['passed', 'failed', 'needs-review'];
const EVIDENCE_KINDS = ['finding', 'image', 'exchange', 'step'] as const;
const LIMITS = { text: 400, lines: 40, line: 400, items: 5000, exchangesPerFinding: 6 } as const;
// A bearer token or JWT must never reach a report, even if the code that built the input forgot to redact it.
const SECRET_SHAPES = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /^\s*authorization\s*:\s*(?!\[redacted\])\S/i, /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/];

class ErrorList {
  readonly errors: ReportError[] = [];
  add(path: string, code: string): void { this.errors.push({ path, code }); }
}

function rejectUnknownKeys(errors: ErrorList, path: string, fields: Fields, keys: readonly string[]): void {
  for (const key of Object.keys(fields)) if (!keys.includes(key)) errors.add(`${path}.${key}`, 'unknown_field');
}
function readText(errors: ErrorList, path: string, value: unknown, longest: number = LIMITS.text, shortest = 1): string {
  if (typeof value !== 'string') { errors.add(path, 'not_text'); return ''; }
  if (value.length < shortest) errors.add(path, 'empty');
  if (value.length > longest) errors.add(path, 'too_long');
  return value;
}
function readOptionalText(errors: ErrorList, path: string, value: unknown): string | null {
  return value === null ? null : readText(errors, path, value);
}
function readId(errors: ErrorList, path: string, value: unknown): string {
  const text = readText(errors, path, value, 64);
  if (text !== '' && !isId(text)) errors.add(path, 'bad_id');
  return text;
}
function readList(errors: ErrorList, path: string, value: unknown, longest: number = LIMITS.items): readonly unknown[] {
  if (!Array.isArray(value)) { errors.add(path, 'not_list'); return []; }
  if (value.length > longest) errors.add(path, 'too_many');
  return value;
}
function readNumber(errors: ErrorList, path: string, value: unknown, lowest = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) { errors.add(path, 'not_number'); return 0; }
  if (value < lowest) errors.add(path, 'out_of_range');
  return value;
}
function readOneOf<Value extends string>(errors: ErrorList, path: string, value: unknown, allowed: readonly Value[], code: string): Value {
  const found = allowed.find((candidate) => candidate === value);
  if (found !== undefined) return found;
  errors.add(path, code);
  return allowed[0] as Value;
}
function readLines(errors: ErrorList, path: string, value: unknown, longest: number = LIMITS.lines): readonly string[] {
  const lines: string[] = [];
  readList(errors, path, value, longest).forEach((line, index) => {
    const text = readText(errors, `${path}[${index}]`, line, LIMITS.line, 0);
    if (SECRET_SHAPES.some((pattern) => pattern.test(text))) errors.add(`${path}[${index}]`, 'secret_shape');
    lines.push(text);
  });
  return lines;
}

function readBox(errors: ErrorList, path: string, value: unknown): PixelBox | null {
  if (value === null) return null;
  if (!isFields(value)) { errors.add(path, 'not_object'); return null; }
  rejectUnknownKeys(errors, path, value, ['x', 'y', 'width', 'height']);
  return {
    x: readNumber(errors, `${path}.x`, value['x'], -1e6), y: readNumber(errors, `${path}.y`, value['y'], -1e6),
    width: readNumber(errors, `${path}.width`, value['width']), height: readNumber(errors, `${path}.height`, value['height']),
  };
}

function readCriterion(errors: ErrorList, path: string, value: unknown): Criterion {
  if (!isFields(value)) { errors.add(path, 'not_object'); return { kind: 'assertion', text: '' }; }
  if (value['kind'] === 'wcag') {
    rejectUnknownKeys(errors, path, value, ['kind', 'successCriterion', 'title', 'level']);
    const successCriterion = readText(errors, `${path}.successCriterion`, value['successCriterion'], 12);
    if (successCriterion !== '' && !/^\d\.\d{1,2}\.\d{1,2}$/.test(successCriterion)) errors.add(`${path}.successCriterion`, 'bad_success_criterion');
    return {
      kind: 'wcag', successCriterion, title: readText(errors, `${path}.title`, value['title']),
      level: readOneOf(errors, `${path}.level`, value['level'], ['A', 'AA', 'AAA'] as const, 'bad_level'),
    };
  }
  if (value['kind'] === 'assertion') {
    rejectUnknownKeys(errors, path, value, ['kind', 'text']);
    return { kind: 'assertion', text: readText(errors, `${path}.text`, value['text']) };
  }
  errors.add(`${path}.kind`, 'unknown_criterion_kind');
  return { kind: 'assertion', text: '' };
}

function readExchange(errors: ErrorList, path: string, value: unknown): Exchange {
  const empty: Exchange = { id: '', method: '', path: '', status: null, requestLines: [], responseLines: [] };
  if (!isFields(value)) { errors.add(path, 'not_object'); return empty; }
  rejectUnknownKeys(errors, path, value, ['id', 'method', 'path', 'status', 'requestLines', 'responseLines']);
  const status = value['status'] === null ? null : readNumber(errors, `${path}.status`, value['status'], 100);
  if (status !== null && status > 599) errors.add(`${path}.status`, 'out_of_range');
  const method = readText(errors, `${path}.method`, value['method'], 10);
  if (method !== '' && !/^[A-Z]{3,7}$/.test(method)) errors.add(`${path}.method`, 'bad_method');
  return {
    id: readId(errors, `${path}.id`, value['id']), method, path: readText(errors, `${path}.path`, value['path'], 300), status,
    requestLines: readLines(errors, `${path}.requestLines`, value['requestLines'], 8),
    responseLines: readLines(errors, `${path}.responseLines`, value['responseLines'], 8),
  };
}

const FINDING_KEYS = ['id', 'status', 'severity', 'title', 'caption', 'rule', 'criterion', 'criterionIds', 'stepIds', 'steps', 'image', 'exchanges', 'log', 'reason', 'action'];

function readFinding(errors: ErrorList, path: string, value: unknown): Finding {
  const empty: Finding = {
    id: '', status: 'failed', severity: 'P4', title: '', caption: '', rule: '', criterion: { kind: 'assertion', text: '' },
    criterionIds: [], stepIds: [], steps: [], image: null, exchanges: [], log: [], reason: null, action: null,
  };
  if (!isFields(value)) { errors.add(path, 'not_object'); return empty; }
  rejectUnknownKeys(errors, path, value, FINDING_KEYS);
  const status = readOneOf(errors, `${path}.status`, value['status'], ['failed', 'needs-review'] as const, 'unknown_status');
  const severity = value['severity'] === null ? null : readOneOf<Severity>(errors, `${path}.severity`, value['severity'], SEVERITIES, 'unknown_severity');
  if (severity === null && status === 'failed') errors.add(`${path}.severity`, 'failed_needs_severity');
  const caption = readText(errors, `${path}.caption`, value['caption'], 200);
  if (wordCount(caption) > MAXIMUM_CAPTION_WORDS) errors.add(`${path}.caption`, 'caption_too_long');
  const steps = readLines(errors, `${path}.steps`, value['steps'], 12);
  if (steps.length < 2) errors.add(`${path}.steps`, 'needs_two_steps');
  let image: Finding['image'] = null;
  if (value['image'] !== null) {
    const rawImage = value['image'];
    if (!isFields(rawImage)) errors.add(`${path}.image`, 'not_object');
    else {
      rejectUnknownKeys(errors, `${path}.image`, rawImage, ['imageId', 'box']);
      image = { imageId: readId(errors, `${path}.image.imageId`, rawImage['imageId']), box: readBox(errors, `${path}.image.box`, rawImage['box']) };
    }
  }
  const exchanges = readList(errors, `${path}.exchanges`, value['exchanges'], LIMITS.exchangesPerFinding)
    .map((exchange, index) => readExchange(errors, `${path}.exchanges[${index}]`, exchange));
  const reason = readOptionalText(errors, `${path}.reason`, value['reason']);
  const action = readOptionalText(errors, `${path}.action`, value['action']);
  if (status === 'needs-review' && (reason === null || action === null)) errors.add(path, 'review_needs_reason_and_action');
  return {
    id: readId(errors, `${path}.id`, value['id']), status, severity, title: readText(errors, `${path}.title`, value['title']), caption,
    rule: readText(errors, `${path}.rule`, value['rule'], 80), criterion: readCriterion(errors, `${path}.criterion`, value['criterion']),
    criterionIds: readList(errors, `${path}.criterionIds`, value['criterionIds'], 50).map((id, index) => readId(errors, `${path}.criterionIds[${index}]`, id)),
    stepIds: readList(errors, `${path}.stepIds`, value['stepIds'], 50).map((id, index) => readId(errors, `${path}.stepIds[${index}]`, id)),
    steps, image, exchanges, log: readLines(errors, `${path}.log`, value['log'], 20), reason, action,
  };
}

function readAcceptanceCriterion(errors: ErrorList, path: string, value: unknown): AcceptanceCriterion {
  const empty: AcceptanceCriterion = { id: '', text: '', status: 'passed', stepIds: [], evidence: [] };
  if (!isFields(value)) { errors.add(path, 'not_object'); return empty; }
  rejectUnknownKeys(errors, path, value, ['id', 'text', 'status', 'stepIds', 'evidence']);
  const stepIds = readList(errors, `${path}.stepIds`, value['stepIds'], 500).map((id, index) => readId(errors, `${path}.stepIds[${index}]`, id));
  if (stepIds.length === 0) errors.add(`${path}.stepIds`, 'criterion_without_steps');
  const evidence: EvidenceReference[] = readList(errors, `${path}.evidence`, value['evidence'], 500).map((entry, index): EvidenceReference => {
    const entryPath = `${path}.evidence[${index}]`;
    if (!isFields(entry)) { errors.add(entryPath, 'not_object'); return { kind: 'step', id: '', label: '' }; }
    rejectUnknownKeys(errors, entryPath, entry, ['kind', 'id', 'label']);
    return {
      kind: readOneOf(errors, `${entryPath}.kind`, entry['kind'], EVIDENCE_KINDS, 'unknown_evidence_kind'),
      id: readId(errors, `${entryPath}.id`, entry['id']), label: readText(errors, `${entryPath}.label`, entry['label']),
    };
  });
  if (evidence.length === 0) errors.add(`${path}.evidence`, 'criterion_without_evidence');
  return {
    id: readId(errors, `${path}.id`, value['id']), text: readText(errors, `${path}.text`, value['text']),
    status: readOneOf(errors, `${path}.status`, value['status'], VERDICTS, 'unknown_verdict'), stepIds, evidence,
  };
}

function readRun(errors: ErrorList, path: string, value: unknown): RunInfo {
  const empty: RunInfo = { runId: '', recordedAt: '', target: '', tool: '', manifestHash: null, inputs: [] };
  if (!isFields(value)) { errors.add(path, 'not_object'); return empty; }
  rejectUnknownKeys(errors, path, value, ['runId', 'recordedAt', 'target', 'tool', 'manifestHash', 'inputs']);
  const recordedAt = readText(errors, `${path}.recordedAt`, value['recordedAt'], 40);
  if (recordedAt !== '' && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/.test(recordedAt)) errors.add(`${path}.recordedAt`, 'bad_time');
  const manifestHash = value['manifestHash'] === null ? null : readText(errors, `${path}.manifestHash`, value['manifestHash'], 64);
  if (manifestHash !== null && !isHex64(manifestHash)) errors.add(`${path}.manifestHash`, 'bad_hash');
  const inputs = readList(errors, `${path}.inputs`, value['inputs'], 200).map((input, index) => {
    const inputPath = `${path}.inputs[${index}]`;
    if (!isFields(input)) { errors.add(inputPath, 'not_object'); return { name: '', sha256: '' }; }
    rejectUnknownKeys(errors, inputPath, input, ['name', 'sha256']);
    const hash = readText(errors, `${inputPath}.sha256`, input['sha256'], 64);
    if (!isHex64(hash)) errors.add(`${inputPath}.sha256`, 'bad_hash');
    return { name: readText(errors, `${inputPath}.name`, input['name'], 200), sha256: hash };
  });
  return {
    runId: readId(errors, `${path}.runId`, value['runId']), recordedAt, target: readText(errors, `${path}.target`, value['target']),
    tool: readText(errors, `${path}.tool`, value['tool']), manifestHash, inputs,
  };
}

const REPORT_KEYS = ['schema', 'reportId', 'kind', 'title', 'subject', 'note', 'run', 'acceptance', 'steps', 'findings', 'images'];

export function parseReportInput(input: unknown): Parsed<ValidReport> {
  const errors = new ErrorList();
  try {
    if (!isFields(input)) return { ok: false, error: [{ path: '$', code: 'not_object' }] };
    rejectUnknownKeys(errors, '$', input, REPORT_KEYS);
    if (input['schema'] !== REPORT_INPUT_SCHEMA) errors.add('$.schema', 'unknown_schema');
    const images: ImageMeta[] = readList(errors, '$.images', input['images'], 500).map((entry, index): ImageMeta => {
      const path = `$.images[${index}]`;
      if (!isFields(entry)) { errors.add(path, 'not_object'); return { id: '', sha256: '', width: 0, height: 0, alt: '' }; }
      rejectUnknownKeys(errors, path, entry, ['id', 'sha256', 'width', 'height', 'alt']);
      const hash = readText(errors, `${path}.sha256`, entry['sha256'], 64);
      if (!isHex64(hash)) errors.add(`${path}.sha256`, 'bad_hash');
      const width = readNumber(errors, `${path}.width`, entry['width'], 1);
      const height = readNumber(errors, `${path}.height`, entry['height'], 1);
      if (!Number.isInteger(width) || !Number.isInteger(height)) errors.add(path, 'not_integer_size');
      return { id: readId(errors, `${path}.id`, entry['id']), sha256: hash, width, height, alt: readText(errors, `${path}.alt`, entry['alt']) };
    });
    const steps: PlanStep[] = readList(errors, '$.steps', input['steps'], 2000).map((entry, index): PlanStep => {
      const path = `$.steps[${index}]`;
      if (!isFields(entry)) { errors.add(path, 'not_object'); return { id: '', text: '', result: '' }; }
      rejectUnknownKeys(errors, path, entry, ['id', 'text', 'result']);
      return {
        id: readId(errors, `${path}.id`, entry['id']), text: readText(errors, `${path}.text`, entry['text']),
        result: readText(errors, `${path}.result`, entry['result'], LIMITS.text, 0),
      };
    });
    const findings = readList(errors, '$.findings', input['findings'], 2000).map((finding, index) => readFinding(errors, `$.findings[${index}]`, finding));
    const acceptance = readList(errors, '$.acceptance', input['acceptance'], 2000)
      .map((criterion, index) => readAcceptanceCriterion(errors, `$.acceptance[${index}]`, criterion));
    const kind = readOneOf(errors, '$.kind', input['kind'], KINDS, 'unknown_kind');
    const value: ReportInput = {
      schema: REPORT_INPUT_SCHEMA, reportId: readId(errors, '$.reportId', input['reportId']), kind,
      title: readText(errors, '$.title', input['title']), subject: readText(errors, '$.subject', input['subject']),
      note: readOptionalText(errors, '$.note', input['note']),
      run: readRun(errors, '$.run', input['run']), acceptance, steps, findings, images,
    };
    // Cross references: every id is unique and every reference resolves.
    const requireUnique = (path: string, ids: readonly string[]): void => {
      const seen = new Set<string>();
      ids.forEach((id, index) => {
        if (seen.has(id)) errors.add(`${path}[${index}]`, 'duplicate_id');
        seen.add(id);
      });
    };
    requireUnique('$.images', images.map((image) => image.id));
    requireUnique('$.steps', steps.map((step) => step.id));
    requireUnique('$.findings', findings.map((finding) => finding.id));
    requireUnique('$.acceptance', acceptance.map((criterion) => criterion.id));
    requireUnique('$.findings.exchanges', findings.flatMap((finding) => finding.exchanges.map((exchange) => exchange.id)));
    const imageIds = new Set(images.map((image) => image.id));
    const stepIds = new Set(steps.map((step) => step.id));
    const criterionIds = new Set(acceptance.map((criterion) => criterion.id));
    const findingIds = new Set(findings.map((finding) => finding.id));
    const exchangeIds = new Set(findings.flatMap((finding) => finding.exchanges.map((exchange) => exchange.id)));
    findings.forEach((finding, index) => {
      if (finding.image !== null && !imageIds.has(finding.image.imageId)) errors.add(`$.findings[${index}].image.imageId`, 'unknown_image');
      finding.stepIds.forEach((id, j) => { if (!stepIds.has(id)) errors.add(`$.findings[${index}].stepIds[${j}]`, 'unknown_step'); });
      finding.criterionIds.forEach((id, j) => { if (!criterionIds.has(id)) errors.add(`$.findings[${index}].criterionIds[${j}]`, 'unknown_criterion'); });
    });
    acceptance.forEach((criterion, index) => {
      criterion.stepIds.forEach((id, j) => { if (!stepIds.has(id)) errors.add(`$.acceptance[${index}].stepIds[${j}]`, 'unknown_step'); });
      criterion.evidence.forEach((entry, j) => {
        const known = entry.kind === 'finding' ? findingIds : entry.kind === 'image' ? imageIds : entry.kind === 'exchange' ? exchangeIds : stepIds;
        if (!known.has(entry.id)) errors.add(`$.acceptance[${index}].evidence[${j}].id`, 'unknown_evidence');
      });
    });
    // The one place a ValidReport is made: after every check above passed.
    return errors.errors.length === 0 ? { ok: true, value: value as ValidReport } : { ok: false, error: errors.errors };
  } catch {
    return { ok: false, error: [{ path: '$', code: 'unreadable' }] };
  }
}

const PERIOD_KEYS = ['id', 'changes', 'changesVerifiedWithoutReview', 'criteriaInScope', 'criteriaTraced', 'runs', 'flakyRuns', 'escaped'];

export function parseHistory(input: unknown): Parsed<History> {
  const errors = new ErrorList();
  try {
    if (!isFields(input)) return { ok: false, error: [{ path: '$', code: 'not_object' }] };
    rejectUnknownKeys(errors, '$', input, ['schema', 'synthetic', 'label', 'periods']);
    if (input['schema'] !== HISTORY_SCHEMA) errors.add('$.schema', 'unknown_schema');
    if (typeof input['synthetic'] !== 'boolean') errors.add('$.synthetic', 'not_boolean');
    const periods: HistoryPeriod[] = readList(errors, '$.periods', input['periods'], 200).map((entry, index): HistoryPeriod => {
      const path = `$.periods[${index}]`;
      const zero: HistoryPeriod = {
        id: '', changes: 0, changesVerifiedWithoutReview: 0, criteriaInScope: 0, criteriaTraced: 0, runs: 0, flakyRuns: 0,
        escaped: { P1: 0, P2: 0, P3: 0, P4: 0 },
      };
      if (!isFields(entry)) { errors.add(path, 'not_object'); return zero; }
      rejectUnknownKeys(errors, path, entry, PERIOD_KEYS);
      const rawEscaped = entry['escaped'];
      let escaped: Fields = {};
      if (isFields(rawEscaped)) escaped = rawEscaped;
      else errors.add(`${path}.escaped`, 'not_object');
      rejectUnknownKeys(errors, `${path}.escaped`, escaped, SEVERITIES);
      const period: HistoryPeriod = {
        id: readId(errors, `${path}.id`, entry['id']),
        changes: readNumber(errors, `${path}.changes`, entry['changes'], 1),
        changesVerifiedWithoutReview: readNumber(errors, `${path}.changesVerifiedWithoutReview`, entry['changesVerifiedWithoutReview']),
        criteriaInScope: readNumber(errors, `${path}.criteriaInScope`, entry['criteriaInScope'], 1),
        criteriaTraced: readNumber(errors, `${path}.criteriaTraced`, entry['criteriaTraced']),
        runs: readNumber(errors, `${path}.runs`, entry['runs'], 1),
        flakyRuns: readNumber(errors, `${path}.flakyRuns`, entry['flakyRuns']),
        escaped: {
          P1: readNumber(errors, `${path}.escaped.P1`, escaped['P1']), P2: readNumber(errors, `${path}.escaped.P2`, escaped['P2']),
          P3: readNumber(errors, `${path}.escaped.P3`, escaped['P3']), P4: readNumber(errors, `${path}.escaped.P4`, escaped['P4']),
        },
      };
      if (period.changesVerifiedWithoutReview > period.changes) errors.add(path, 'verified_exceeds_changes');
      if (period.criteriaTraced > period.criteriaInScope) errors.add(path, 'traced_exceeds_total');
      if (period.flakyRuns > period.runs) errors.add(path, 'flaky_exceeds_runs');
      return period;
    });
    if (periods.length === 0) errors.add('$.periods', 'empty');
    const value: History = { schema: HISTORY_SCHEMA, synthetic: input['synthetic'] === true, label: readText(errors, '$.label', input['label']), periods };
    return errors.errors.length === 0 ? { ok: true, value } : { ok: false, error: errors.errors };
  } catch {
    return { ok: false, error: [{ path: '$', code: 'unreadable' }] };
  }
}
