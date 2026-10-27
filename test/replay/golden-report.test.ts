// Golden replay of the visual evidence report: the three recorded runs must render to the
// recorded report, PR comment, top-finding image and manifest, byte for byte. A change to the
// output is a deliberate change to the files under golden/report/, reviewed like any test.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate, sha256 } from '@revisum/report';
import { loaded } from '../support/report-fixtures.ts';
import { GOLDEN } from '../support/repository.ts';

const GOLDEN_REPORTS = join(GOLDEN, 'report');

test('every recorded run renders to its golden report byte for byte', { criterion: 'AC-SPEC-00-01' }, () => {
  assert.deepEqual(readdirSync(GOLDEN_REPORTS).sort(), loaded.reports.map((report) => report.input.reportId).sort(), 'one golden folder per recorded run');
  for (const report of loaded.reports) {
    const folder = join(GOLDEN_REPORTS, report.input.reportId);
    const files = generate(report.input, { png: report.assets }, loaded.history);
    assert.deepEqual(files.map((file) => file.name).sort(), readdirSync(folder).sort(), `${report.input.reportId}: the same files`);
    for (const file of files) {
      const golden = readFileSync(join(folder, file.name));
      assert.equal(sha256(file.bytes), sha256(golden), `${report.input.reportId}/${file.name} matches the golden file`);
    }
  }
});
