// Loads the three recorded report inputs (accessibility, functional and API runs), their
// screenshots and the demo metrics history once, through the report package's own parsers, and
// generates each report once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, parseHistory, parseReportInput, type History, type Output, type ValidReport } from '@revisum/report';
import { FIXTURES } from './repository.ts';

export const REPORT_INPUTS = join(FIXTURES, 'report-inputs');
export const ALL_KINDS = ['a11y', 'functional', 'api'] as const;
export type ReportKindName = (typeof ALL_KINDS)[number];

export type LoadedReport = { readonly input: ValidReport; readonly assets: ReadonlyMap<string, Uint8Array> };
export type LoadedReports = { readonly reports: readonly LoadedReport[]; readonly history: History };

const readJson = (name: string): unknown => JSON.parse(readFileSync(join(REPORT_INPUTS, name), 'utf8'));

function loadReport(kind: ReportKindName): LoadedReport {
  const parsed = parseReportInput(readJson(`${kind}.json`));
  if (!parsed.ok) throw new Error(`${kind} report input rejected: ${JSON.stringify(parsed.error.slice(0, 5))}`);
  const assets = new Map<string, Uint8Array>();
  for (const image of parsed.value.images) {
    assets.set(image.id, new Uint8Array(readFileSync(join(REPORT_INPUTS, kind, 'images', `${image.id}.png`))));
  }
  return { input: parsed.value, assets };
}

function loadHistory(): History {
  const parsed = parseHistory(readJson('history.json'));
  if (!parsed.ok) throw new Error(`history rejected: ${JSON.stringify(parsed.error.slice(0, 5))}`);
  return parsed.value;
}

export const loaded: LoadedReports = { reports: ALL_KINDS.map(loadReport), history: loadHistory() };

export const byKind = (kind: ReportKindName): ValidReport => {
  const report = loaded.reports.find((candidate) => candidate.input.kind === kind);
  if (report === undefined) throw new Error(`no ${kind} report`);
  return report.input;
};
export const assetsOf = (report: ValidReport): { png: ReadonlyMap<string, Uint8Array> } =>
  ({ png: loaded.reports.find((candidate) => candidate.input === report)?.assets ?? new Map() });

const generated = new Map<string, readonly Output[]>();
export function outputs(report: ValidReport): readonly Output[] {
  const cached = generated.get(report.reportId);
  if (cached) return cached;
  const fresh = generate(report, assetsOf(report), loaded.history);
  generated.set(report.reportId, fresh);
  return fresh;
}
export const outputText = (files: readonly Output[], name: string): string => {
  const file = files.find((candidate) => candidate.name === name);
  if (file === undefined) throw new Error(`no output ${name}`);
  return new TextDecoder().decode(file.bytes);
};
export const reportHtml = (report: ValidReport): string => outputText(outputs(report), 'report.html');

export const idsIn = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? '');
export const hrefsIn = (html: string): string[] => [...html.matchAll(/\shref="#([^"]*)"/g)].map((match) => match[1] ?? '');
