// Browser upkeep: what each new Chrome for Testing major costs to re-validate the own CDP driver,
// and when that cost says to return to the Playwright fallback (the rule in the MVP plan's kill
// criteria: over 1.8 hours of fixes per major, on average, across the first six majors).
//   node tools/browser-upkeep.ts [--records <file>] [--versions <file>] [--pinned <build>]
//     --records   the upkeep records, a JSON list of { browser, major, fixHours, revalidatedAt };
//                 by default docs/decisions/browser-upkeep.json under the working folder.
//     --versions  Chrome for Testing's version list (last-known-good-versions.json). When given,
//                 the Stable channel's major is compared with the pinned build's, and a newer
//                 major with no upkeep record fails.
//     --pinned    the pinned build; by default CHROME_FOR_TESTING_BUILD in tools/install-browsers.ts.
// It prints the average fixHours over the first six Chrome majors, or the running average while
// there are fewer, and exits 1 when it flags the fallback rule or a check fails. The session adds
// a record when it moves the pin; the founder's push approves it. A weekly CI job runs this tool.
// See docs/specs/SPEC-06-cdp-driver.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHROME_FOR_TESTING_BUILD } from './install-browsers.ts';

export const UPKEEP_RECORDS_FILE = 'docs/decisions/browser-upkeep.json';
// The kill criterion: majors counted, and the most fix hours per major they may average.
export const MAJORS_COUNTED = 6;
export const MAXIMUM_AVERAGE_FIX_HOURS = 1.8;

const BROWSERS = ['chrome', 'firefox'] as const;
// One re-validation of the driver on a new browser major, and the hours its fixes took.
export type UpkeepRecord = {
  readonly browser: (typeof BROWSERS)[number];
  readonly major: number;
  readonly fixHours: number;
  readonly revalidatedAt: string;
};

type Decoded<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly faults: readonly string[] };

const RECORD_FIELDS = ['browser', 'major', 'fixHours', 'revalidatedAt'];
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// Decodes the records file's JSON. Every fault is named by its record and field; nothing is
// guessed or dropped.
export function decodeUpkeepRecords(input: unknown): Decoded<readonly UpkeepRecord[]> {
  if (!Array.isArray(input)) return { ok: false, faults: ['the records file must hold a JSON list (an array) of upkeep records'] };
  const faults: string[] = [];
  const records: UpkeepRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of input.entries()) {
    const where = `record ${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      faults.push(`${where} is not an object`);
      continue;
    }
    const fields = entry as Record<string, unknown>;
    const before = faults.length;
    for (const field of Object.keys(fields)) if (!RECORD_FIELDS.includes(field)) faults.push(`${where}: unknown field ${field}`);
    for (const field of RECORD_FIELDS) if (!(field in fields)) faults.push(`${where}: ${field} is missing`);
    const { browser, major, fixHours, revalidatedAt } = fields;
    if ('browser' in fields && !BROWSERS.some((known) => known === browser)) {
      faults.push(`${where}: browser ${JSON.stringify(browser)} is not ${BROWSERS.join(' or ')}`);
    }
    if ('major' in fields && !(typeof major === 'number' && Number.isInteger(major) && major > 0)) {
      faults.push(`${where}: major ${JSON.stringify(major)} is not a whole browser major`);
    }
    if ('fixHours' in fields && !(typeof fixHours === 'number' && Number.isFinite(fixHours) && fixHours >= 0)) {
      faults.push(`${where}: fixHours must be a number of hours, 0 or more`);
    }
    if ('revalidatedAt' in fields && !(typeof revalidatedAt === 'string' && ISO_DATE_TIME.test(revalidatedAt) && !Number.isNaN(Date.parse(revalidatedAt)))) {
      faults.push(`${where}: revalidatedAt must be an ISO 8601 date and time, such as 2026-07-21T09:00:00Z`);
    }
    if (faults.length > before) continue;
    const record = { browser, major, fixHours, revalidatedAt } as UpkeepRecord;
    const key = `${record.browser} ${record.major}`;
    if (seen.has(key)) {
      faults.push(`${where}: ${record.browser} major ${record.major} already has a record`);
      continue;
    }
    seen.add(key);
    records.push(record);
  }
  return faults.length === 0 ? { ok: true, value: records } : { ok: false, faults };
}

export type UpkeepSummary = {
  // How many Chrome majors the average covers: the first six, or all of them while there are fewer.
  readonly majorsCovered: number;
  // Null while there is no Chrome record.
  readonly averageFixHours: number | null;
  // True only once six Chrome majors average over the limit.
  readonly fallbackFlagged: boolean;
};

export function summariseUpkeep(records: readonly UpkeepRecord[]): UpkeepSummary {
  const first = records.filter((record) => record.browser === 'chrome')
    .toSorted((left, right) => left.major - right.major)
    .slice(0, MAJORS_COUNTED);
  if (first.length === 0) return { majorsCovered: 0, averageFixHours: null, fallbackFlagged: false };
  const average = first.reduce((total, record) => total + record.fixHours, 0) / first.length;
  return { majorsCovered: first.length, averageFixHours: average, fallbackFlagged: first.length === MAJORS_COUNTED && average > MAXIMUM_AVERAGE_FIX_HOURS };
}

const majorOf = (build: string): number | null => {
  const match = /^(\d+)\.\d+\.\d+\.\d+$/.exec(build);
  return match?.[1] === undefined ? null : Number(match[1]);
};

export type StableMajor = { readonly version: string; readonly major: number; readonly newer: boolean };

// The Stable channel's version from Chrome for Testing's version list, and whether its major is
// newer than the pinned build's.
export function newerStableMajor(versionList: unknown, pinnedBuild: string): Decoded<StableMajor> {
  const pinnedMajor = majorOf(pinnedBuild);
  if (pinnedMajor === null) return { ok: false, faults: [`the pinned build ${pinnedBuild} is not a four-part Chrome version`] };
  const channels = typeof versionList === 'object' && versionList !== null ? (versionList as Record<string, unknown>)['channels'] : undefined;
  const stable = typeof channels === 'object' && channels !== null ? (channels as Record<string, unknown>)['Stable'] : undefined;
  const version = typeof stable === 'object' && stable !== null ? (stable as Record<string, unknown>)['version'] : undefined;
  const major = typeof version === 'string' ? majorOf(version) : null;
  if (typeof version !== 'string' || major === null) return { ok: false, faults: ['the version list has no Stable version'] };
  return { ok: true, value: { version, major, newer: major > pinnedMajor } };
}

type Options = { readonly records: string; readonly versions: string | null; readonly pinned: string };

function readOptions(words: readonly string[], root: string): Options | string {
  const values = new Map<string, string>();
  for (let index = 0; index < words.length; index += 2) {
    const flag = words[index] ?? '';
    const value = words[index + 1];
    if (!['--records', '--versions', '--pinned'].includes(flag) || value === undefined) {
      return 'usage: node tools/browser-upkeep.ts [--records <file>] [--versions <file>] [--pinned <build>]';
    }
    values.set(flag, value);
  }
  return {
    records: values.get('--records') ?? join(root, UPKEEP_RECORDS_FILE),
    versions: values.get('--versions') ?? null,
    pinned: values.get('--pinned') ?? CHROME_FOR_TESTING_BUILD,
  };
}

function readJson(path: string): Decoded<unknown> {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, faults: [`${path} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function main(words: readonly string[], root: string): number {
  const options = readOptions(words, root);
  if (typeof options === 'string') {
    console.error(options);
    return 2;
  }
  const raw = readJson(options.records);
  const decoded = raw.ok ? decodeUpkeepRecords(raw.value) : raw;
  if (!decoded.ok) {
    for (const fault of decoded.faults) console.error(`browser upkeep: ${fault}`);
    return 1;
  }
  let status = 0;
  const summary = summariseUpkeep(decoded.value);
  if (summary.averageFixHours === null) {
    console.log('browser upkeep: no Chrome upkeep records yet, so there is no average to compare.');
  } else {
    const average = summary.averageFixHours.toFixed(2);
    const scope = summary.majorsCovered === MAJORS_COUNTED
      ? `the first ${MAJORS_COUNTED} Chrome majors`
      : `${summary.majorsCovered} Chrome major(s) so far (running average; the rule needs ${MAJORS_COUNTED})`;
    console.log(`browser upkeep: average fix hours ${average} over ${scope}; the limit is ${MAXIMUM_AVERAGE_FIX_HOURS.toFixed(2)}.`);
    if (summary.fallbackFlagged) {
      console.error(`browser upkeep: FLAG: fixes average ${average} hours per major, over ${MAXIMUM_AVERAGE_FIX_HOURS}, across the first `
        + `${MAJORS_COUNTED} Chrome majors. The Playwright fallback rule in the MVP plan's kill criteria applies: decide whether to return `
        + 'to the Playwright fallback adapter.');
      status = 1;
    }
  }
  if (options.versions !== null) {
    const list = readJson(options.versions);
    const stable = list.ok ? newerStableMajor(list.value, options.pinned) : list;
    if (!stable.ok) {
      for (const fault of stable.faults) console.error(`browser upkeep: ${fault}`);
      return 1;
    }
    const { version, major, newer } = stable.value;
    if (!newer) {
      console.log(`browser upkeep: Chrome for Testing Stable ${version} is not a newer major than the pinned build ${options.pinned}.`);
    } else if (decoded.value.some((record) => record.browser === 'chrome' && record.major === major)) {
      console.log(`browser upkeep: Chrome for Testing Stable is major ${major} (${version}), newer than the pinned build ${options.pinned}; it has an upkeep record.`);
    } else {
      console.error(`browser upkeep: Chrome for Testing Stable is major ${major} (${version}), newer than the pinned build ${options.pinned}, and has no `
        + `upkeep record. Re-run the contract and capability suites on it, then add its upkeep record to ${UPKEEP_RECORDS_FILE} when moving the pin.`);
      status = 1;
    }
  }
  return status;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.cwd());
