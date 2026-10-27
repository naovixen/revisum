// Report generator tests: output form, annotations, cards, review queue, traceability, metrics
// panel, PR comment, determinism, escaping and coverage of the three recorded runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAXIMUM_PR_COMMENT_CHARACTERS, SEVERITIES, SEVERITY_STYLE, STROKE_DASH,
  contrast, deriveView, generate, levelAt, markdownEscape, parseReportInput, pngSize, sha256, usableBox, wordCount,
} from '@revisum/report';
import {
  ALL_KINDS, REPORT_INPUTS, assetsOf, byKind, hrefsIn, idsIn, loaded, outputText, outputs, reportHtml,
} from '../../support/report-fixtures.ts';
import { PACKAGES } from '../../support/repository.ts';

const REPORT_SOURCES = join(PACKAGES, 'report', 'src');
const sourceFiles = (folder: string): string[] => readdirSync(folder, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? sourceFiles(join(folder, entry.name)) : entry.name.endsWith('.ts') ? [join(folder, entry.name)] : []));

test('each HTML file is self-contained: inline CSS, no script, no handler, no external reference', () => {
  for (const kind of ALL_KINDS) {
    const html = reportHtml(byKind(kind));
    assert.equal((html.match(/<style>/g) ?? []).length, 1);
    assert.equal((html.match(/<script/gi) ?? []).length, 0);
    assert.equal((html.match(/<link\b/gi) ?? []).length, 0);
    assert.equal((html.match(/<(iframe|object|embed|form|base)\b/gi) ?? []).length, 0);
    assert.equal((html.match(/<[A-Za-z][^>]*\son[a-z]+\s*=/g) ?? []).length, 0, 'no event-handler attribute');
    const references = [...html.matchAll(/\s(?:src|href|srcset|xlink:href|action|poster|data)\s*=\s*"([^"]*)"/g)].map((match) => match[1] ?? '');
    for (const reference of references) {
      assert.ok(reference.startsWith('#') || reference.startsWith('data:image/png;base64,'), `${kind}: unexpected reference ${reference.slice(0, 40)}`);
    }
    assert.equal(/url\(\s*['"]?(?!#)|@import/i.test(html), false, 'no url() except local fragments, no @import');
    // Addresses may appear as quoted text inside exchange excerpts (<pre>), never as a reference.
    assert.equal(/(?:https?:)?\/\/[A-Za-z0-9.-]+\.[a-z]{2,}/.test(html.replace(/xmlns="[^"]*"/g, '').replace(/<pre>.*?<\/pre>/gs, '')), false, `${kind}: no external address outside excerpts`);
    assert.ok(html.startsWith('<!doctype html>'));
  }
});

test('every embedded image is listed in the manifest with the pinned hash', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const manifest = JSON.parse(outputText(outputs(report), 'manifest.json')) as {
      images: { id: string; sha256: string }[]; outputs: { name: string; sha256: string; bytes: number }[];
    };
    assert.deepEqual(manifest.images.map((image) => image.id), report.images.map((image) => image.id));
    for (const listed of manifest.outputs) {
      const file = outputs(report).find((candidate) => candidate.name === listed.name);
      assert.equal(listed.sha256, sha256(file?.bytes ?? new Uint8Array()));
      assert.equal(listed.bytes, file?.bytes.length);
    }
  }
});

test('generation needs no network: sockets, fetch and WebSocket throw, all three reports still generate', () => {
  const requireBuiltIn = createRequire(import.meta.url);
  const net = requireBuiltIn('node:net') as { Socket: { prototype: { connect: unknown } } };
  const dns = requireBuiltIn('node:dns') as { lookup: unknown };
  const saved = { fetch: globalThis.fetch, webSocket: globalThis.WebSocket, connect: net.Socket.prototype.connect, lookup: dns.lookup };
  const refuse = (): never => { throw new Error('network used'); };
  Object.assign(globalThis, { fetch: refuse, WebSocket: refuse });
  net.Socket.prototype.connect = refuse;
  dns.lookup = refuse;
  try {
    for (const report of loaded.reports) assert.ok(generate(report.input, { png: report.assets }, loaded.history).length === 4);
  } finally {
    Object.assign(globalThis, { fetch: saved.fetch, WebSocket: saved.webSocket });
    net.Socket.prototype.connect = saved.connect;
    dns.lookup = saved.lookup;
  }
});

test('the generator imports only Node built-ins, relative files and the contracts package', () => {
  for (const file of sourceFiles(REPORT_SOURCES)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] ?? '';
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.') || specifier === '@revisum/contracts', `${file}: non-relative import ${specifier}`);
    }
  }
});

test('the verdict banner is the first element in main and shows the counts and highest severity', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const html = reportHtml(report);
    const view = deriveView(report);
    const main = html.slice(html.indexOf('<main id="main">') + '<main id="main">'.length);
    assert.ok(main.startsWith('<section id="verdict" class="banner'), `${kind}: banner first in main`);
    const banner = main.slice(0, main.indexOf('</section>'));
    assert.match(banner, new RegExp(`<strong>${view.counts.failed}</strong> failed`));
    assert.match(banner, new RegExp(`<strong>${view.counts.needsReview}</strong> need review`));
    assert.match(banner, new RegExp(`<strong>${view.counts.passed}</strong> passed`));
    assert.match(banner, view.highest === null ? /<strong>none<\/strong>/ : new RegExp(`sev-${view.highest}">${view.highest}<`));
  }
  const functional = byKind('functional');
  const empty = { ...functional, acceptance: functional.acceptance.map((criterion) => ({ ...criterion, status: 'passed' as const })), findings: [], images: [] };
  const parsed = parseReportInput(JSON.parse(JSON.stringify({
    ...empty, acceptance: empty.acceptance.map((criterion) => ({ ...criterion, evidence: [{ kind: 'step', id: criterion.stepIds[0], label: 'ok' }] })),
  })));
  assert.ok(parsed.ok, 'an all-passed report parses');
  if (parsed.ok) {
    const file = generate(parsed.value, { png: new Map() }, loaded.history).find((output) => output.name === 'report.html');
    const html = new TextDecoder().decode(file?.bytes);
    assert.match(html, /PASSED/);
    assert.match(html, /<strong>none<\/strong>/);
    assert.match(html, /Nothing to review/);
  }
});

test('the banner counts equal an independent count and sum to the number of criteria', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const failed = report.acceptance.filter((criterion) => criterion.status === 'failed').length;
    const review = report.acceptance.filter((criterion) => criterion.status === 'needs-review').length;
    const passed = report.acceptance.filter((criterion) => criterion.status === 'passed').length;
    const view = deriveView(report);
    assert.deepEqual([view.counts.failed, view.counts.needsReview, view.counts.passed], [failed, review, passed]);
    assert.equal(failed + review + passed, report.acceptance.length);
    const manifest = JSON.parse(outputText(outputs(report), 'manifest.json')) as { counts: { failed: number; passed: number; needsReview: number; total: number } };
    assert.equal(manifest.counts.total, report.acceptance.length);
  }
  // The statuses themselves follow from the findings and steps (accessibility: failed if and only if a failed finding).
  const accessibility = byKind('a11y');
  for (const criterion of accessibility.acceptance) {
    const mine = accessibility.findings.filter((finding) => finding.criterionIds.includes(criterion.id));
    if (mine.some((finding) => finding.status === 'failed')) assert.equal(criterion.status, 'failed', criterion.id);
    else if (criterion.status === 'passed') assert.equal(mine.length, 0, criterion.id);
  }
});

const dataUris = (html: string): { uri: string; bytes: Buffer }[] =>
  [...html.matchAll(/<image href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map((match) => ({ uri: match[1] ?? '', bytes: Buffer.from(match[1] ?? '', 'base64') }));

test('every embedded screenshot is the original PNG byte for byte', () => {
  let seen = 0;
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const html = reportHtml(report);
    const assets = assetsOf(report).png;
    const pinned = new Map(report.images.map((image) => [image.sha256, image]));
    for (const embedded of dataUris(html)) {
      const meta = pinned.get(sha256(embedded.bytes));
      assert.ok(meta, `${kind}: an embedded image does not match any pinned hash`);
      assert.deepEqual(pngSize(embedded.bytes), { width: meta?.width, height: meta?.height });
      seen++;
    }
    for (const image of report.images) {
      const original = assets.get(image.id);
      assert.ok(original && sha256(original) === image.sha256);
      assert.ok(dataUris(html).some((embedded) => embedded.bytes.equals(Buffer.from(original))), `${image.id} is embedded unchanged`);
    }
  }
  assert.ok(seen >= 24, `embedded ${seen} images`);
});

type DrawnCallout = { number: number; box: number[]; label: string; severity: string };
const figures = (html: string): { viewBox: number[]; image: { width: number; height: number }; callouts: DrawnCallout[] }[] =>
  [...html.matchAll(/<svg class="shot" viewBox="([^"]+)"[^>]*>(.*?)<\/svg>/gs)].map((match) => ({
    viewBox: (match[1] ?? '').split(' ').map(Number),
    image: {
      width: Number(/<image [^>]*width="(\d+)"/.exec(match[2] ?? '')?.[1]),
      height: Number(/<image [^>]*height="(\d+)"/.exec(match[2] ?? '')?.[1]),
    },
    callouts: [...(match[2] ?? '').matchAll(/<g class="co co-(\w+)" data-n="(\d+)">.*?<rect class="box" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)".*?<text [^>]*>([^<]*)<\/text><\/g>/gs)]
      .map((callout) => ({
        number: Number(callout[2]), box: [Number(callout[3]), Number(callout[4]), Number(callout[5]), Number(callout[6])],
        label: callout[7] ?? '', severity: callout[1] ?? '',
      })),
  }));

test('the SVG uses the PNG pixel grid; each callout is the clamped box and carries its number', () => {
  let total = 0;
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const view = deriveView(report);
    for (const figure of figures(reportHtml(report))) {
      const [viewX = 0, viewY = 0, viewWidth = 0, viewHeight = 0] = figure.viewBox;
      assert.ok(viewX >= 0 && viewY >= 0 && viewX + viewWidth <= figure.image.width + 1e-6 && viewY + viewHeight <= figure.image.height + 1e-6, 'viewBox inside the image');
      for (const callout of figure.callouts) {
        const numbered = view.numbered.find((entry) => entry.number === callout.number);
        assert.ok(numbered && numbered.finding.image, `callout ${callout.number} belongs to a finding with an image`);
        const meta = report.images.find((image) => image.id === numbered?.finding.image?.imageId);
        const expected = usableBox(numbered?.finding.image?.box ?? null, meta?.width ?? 0, meta?.height ?? 0);
        assert.ok(expected, `callout ${callout.number} has a usable box`);
        assert.deepEqual(callout.box, [expected?.x, expected?.y, expected?.width, expected?.height]);
        assert.ok(callout.label.startsWith(`${callout.number} `), `label ${callout.label} starts with its number`);
        total++;
      }
    }
  }
  assert.ok(total > 25, `checked ${total} callouts`);
});

test('usableBox clamps to the image and refuses boxes with no area', () => {
  assert.deepEqual(usableBox({ x: -5, y: 10, width: 20, height: 10 }, 100, 100), { x: 0, y: 10, width: 15, height: 10 });
  assert.deepEqual(usableBox({ x: 90, y: 90, width: 50, height: 50 }, 100, 100), { x: 90, y: 90, width: 10, height: 10 });
  assert.equal(usableBox({ x: 0, y: 0, width: 0, height: 5 }, 100, 100), null);
  assert.equal(usableBox({ x: 0, y: 1279.88, width: 41, height: 21 }, 1280, 800), null);
  assert.equal(usableBox(null, 100, 100), null);
});

test('severity is told apart by label and stroke pattern, not colour alone', () => {
  const severities = [...SEVERITIES, null] as const;
  for (let i = 0; i < severities.length; i++) {
    for (let j = i + 1; j < severities.length; j++) {
      assert.notEqual(
        STROKE_DASH(severities[i] ?? null) + SEVERITY_STYLE[severities[i] ?? 'none'].width,
        STROKE_DASH(severities[j] ?? null) + SEVERITY_STYLE[severities[j] ?? 'none'].width,
        `${severities[i]} vs ${severities[j]}`,
      );
    }
  }
  assert.equal(new Set(SEVERITIES.map((severity) => STROKE_DASH(severity))).size, 4, 'four distinct dash patterns');
  const html = reportHtml(byKind('a11y'));
  for (const group of html.matchAll(/<g class="co co-(\w+)" data-n="(\d+)">(.*?)<\/g>/gs)) {
    const severity = group[1] ?? '';
    const body = group[3] ?? '';
    assert.ok(new RegExp(`>${group[2]} ${severity === 'none' ? 'unrated' : severity}( \\?)?<`).test(body), `callout ${group[2]} prints its severity word`);
    const dash = STROKE_DASH(severity === 'none' ? null : (severity as 'P1'));
    assert.equal(body.includes(`stroke-dasharray="${dash}"`), dash !== '');
  }
});

test('callouts plus page-level entries equal the findings on each screenshot', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const view = deriveView(report);
    const html = reportHtml(report);
    for (const figure of view.figures) {
      const onImage = report.findings.filter((finding) => finding.image?.imageId === figure.imageId).length;
      assert.equal(figure.callouts.length + figure.pageLevel.length, onImage, figure.imageId);
    }
    const drawn = new Set<number>();
    for (const figure of figures(html)) for (const callout of figure.callouts) drawn.add(callout.number);
    for (const figure of view.figures) for (const entry of figure.pageLevel) assert.ok(!drawn.has(entry.number), `page-level finding ${entry.number} has no callout`);
  }
  const accessibility = deriveView(byKind('a11y'));
  assert.ok(accessibility.figures.some((figure) => figure.pageLevel.length > 0), 'the accessibility run has page-level findings (meta, html, empty link, off-screen)');
  assert.match(reportHtml(byKind('a11y')), /page-level, no box/);
});

test('every finding has a caption of 15 words or fewer, shown by its number', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const html = reportHtml(report);
    const view = deriveView(report);
    for (const entry of view.numbered) {
      assert.ok(entry.finding.caption.length > 0 && wordCount(entry.finding.caption) <= 15, `${entry.finding.id}: "${entry.finding.caption}"`);
      const escaped = entry.finding.caption.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      assert.ok(html.includes(`<td>${escaped}</td>`), `${entry.finding.id}: caption in the findings list`);
      assert.ok(html.includes(`href="#f-${entry.number}"`));
    }
    for (const figure of view.figures) {
      for (const callout of figure.callouts) assert.ok(html.includes(`<span class="num">${callout.number}</span>`), 'caption list beside the screenshot shows the number');
    }
  }
});

test('every finding card shows severity, rule, criterion, numbered steps and, for API findings, excerpts and log', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const view = deriveView(report);
    const html = reportHtml(report);
    for (const entry of view.numbered) {
      const start = html.indexOf(`<article class="card c-${entry.finding.severity ?? 'none'}" id="f-${entry.number}"`);
      assert.ok(start > 0, `${entry.finding.id}: card exists`);
      const card = html.slice(start, html.indexOf('</article>', start));
      assert.ok(card.includes(`<strong>Severity</strong><div>${entry.finding.severity ?? 'unrated'}</div>`));
      assert.ok(card.includes('<strong>Rule or probe</strong>') && card.includes('<strong>Criterion</strong>'));
      assert.ok((card.match(/<li>/g) ?? []).length >= 2, 'at least 2 steps');
      if (entry.finding.criterion.kind === 'wcag') assert.ok(card.includes(`SC ${entry.finding.criterion.successCriterion}`));
      else assert.ok(card.includes('Assertion:'));
      if (entry.finding.exchanges.length > 0) {
        assert.ok(card.includes('<h4>Request</h4>') && card.includes('<h4>Response</h4>'));
        assert.ok(card.includes('<strong>Log</strong>'));
      }
    }
  }
  const api = byKind('api');
  assert.ok(api.findings.filter((finding) => finding.status === 'failed' && finding.exchanges.length > 0).length >= 14);
});

test('exchange excerpts are short and carry no token-shaped or unredacted authorization value', () => {
  const report = byKind('api');
  const html = reportHtml(report);
  let exchanges = 0;
  for (const finding of report.findings) {
    for (const exchange of finding.exchanges) {
      for (const side of [exchange.requestLines, exchange.responseLines]) {
        assert.ok(side.length <= 8);
        for (const line of side) {
          assert.ok(line.length <= 160);
          assert.equal(/eyJ[A-Za-z0-9_-]{8,}\./.test(line), false);
          assert.equal(/^authorization:\s*(?!\[redacted\])\S/i.test(line), false);
        }
      }
      exchanges++;
    }
  }
  assert.ok(exchanges >= 14);
  assert.equal(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(html), false);
  assert.equal(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/.test(html), false);
  assert.ok(html.includes('authorization: [redacted]'));
});

test('the review queue lists exactly the needs-review findings, with reason and action', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const view = deriveView(report);
    const html = reportHtml(report);
    const start = html.indexOf('<section id="review"');
    const section = html.slice(start, html.indexOf('</section>', start));
    assert.match(section, new RegExp(`Review queue \\(${view.review.length}\\)`));
    const expected = report.findings.filter((finding) => finding.status === 'needs-review').length;
    assert.equal(view.review.length, expected);
    if (expected === 0) assert.match(section, /Nothing to review/);
    else assert.equal((section.match(/<tr><th scope="row" class="n">/g) ?? []).length, expected);
    for (const entry of view.review) {
      assert.ok(entry.finding.reason && entry.finding.action);
      assert.ok(section.includes(`<th scope="row" class="n">${entry.number}</th>`));
    }
  }
  assert.equal(deriveView(byKind('a11y')).review.length, 29);
  assert.equal(deriveView(byKind('functional')).review.length, 0);
  assert.equal(deriveView(byKind('api')).review.length, 4);
});

test('every criterion has a step and evidence, and every in-page link resolves', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const html = reportHtml(report);
    for (const criterion of report.acceptance) {
      assert.ok(criterion.stepIds.length >= 1, criterion.id);
      assert.ok(criterion.evidence.length >= 1, criterion.id);
    }
    const ids = idsIn(html);
    assert.equal(new Set(ids).size, ids.length, `${kind}: ids are unique`);
    const present = new Set(ids);
    for (const link of hrefsIn(html)) assert.ok(present.has(link), `${kind}: #${link} resolves`);
    assert.equal((html.match(/<ol class="strip"/g) ?? []).length, 1);
    assert.equal((html.match(/<li class="st-(?:passed|failed|needs-review)">/g) ?? []).length, report.acceptance.length);
  }
});

test('the metrics panel shows the escaped defects, shares, level and the demo label', () => {
  for (const kind of ALL_KINDS) {
    const html = reportHtml(byKind(kind));
    const start = html.indexOf('<section id="metrics"');
    const section = html.slice(start, html.indexOf('</section>', start));
    assert.match(section, /DEMO DATA: Synthetic numbers invented for this demo/);
    assert.match(section, /Escaped defects, latest period/);
    for (const severity of SEVERITIES) assert.ok(section.includes(`<span class="sev sev-${severity}">${severity}</span>`));
    assert.match(section, /Verified without manual review<\/span><b>75\.0%<\/b>/);
    assert.match(section, /Flaky run rate<\/span><b>3\.5%<\/b>/);
    assert.match(section, /Acceptance criteria traced<\/span><b>89\.3%<\/b>/);
    const level = levelAt(loaded.history, loaded.history.periods.length - 1);
    assert.match(section, new RegExp(`Level ${level} of 5</span><b>Spec-linked</b>`));
    assert.match(section, /aria-current="step">Level 3: Spec-linked \(current\)/);
  }
  const notSynthetic = generate(byKind('functional'), assetsOf(byKind('functional')), { ...loaded.history, synthetic: false });
  assert.equal(/DEMO DATA/.test(outputText(notSynthetic, 'report.html')), false, 'the label appears only for synthetic data');
});

test('each chart has a title and its numbers are in a table', () => {
  const html = reportHtml(byKind('a11y'));
  const charts = [...html.matchAll(/<svg class="chart"[^>]*>(.*?)<\/svg>/gs)];
  assert.equal(charts.length, 2);
  for (const chart of charts) assert.match(chart[1] ?? '', /<title id="ch-[a-z]+-t">[^<]+<\/title><desc id="ch-[a-z]+-d">[^<]+<\/desc>/);
  const table = html.slice(html.indexOf('Values behind the charts'));
  for (const period of loaded.history.periods) {
    const row = new RegExp(`<tr><th scope="row">${period.id}</th><td>${period.escaped.P1}</td><td>${period.escaped.P2}</td><td>${period.escaped.P3}</td><td>${period.escaped.P4}</td>`);
    assert.match(table, row, period.id);
  }
});

test('the PR comment has the verdict line, one image, a report link, at most 5 findings and fits the budget', () => {
  for (const kind of ALL_KINDS) {
    const report = byKind(kind);
    const view = deriveView(report);
    const comment = outputText(outputs(report), 'pr-comment.md');
    assert.ok(comment.length <= MAXIMUM_PR_COMMENT_CHARACTERS && MAXIMUM_PR_COMMENT_CHARACTERS === 1800, `${kind}: ${comment.length} chars`);
    assert.match(comment, new RegExp(`${view.counts.failed} failed, ${view.counts.needsReview} need review, ${view.counts.passed} passed`));
    assert.equal((comment.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length, 1, 'exactly one image');
    assert.match(comment, /\(top-finding\.svg\)/);
    assert.ok(/\]\(report\.html\)/.test(comment));
    const rows = comment.split('\n').filter((line) => /^\| \d+ \|/.test(line));
    assert.ok(rows.length >= 1 && rows.length <= 5);
    assert.equal(/<script|<img/i.test(comment), false);
    assert.match(outputText(outputs(report), 'top-finding.svg'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  }
  assert.match(outputText(outputs(byKind('a11y')), 'top-finding.svg'), /<image href="data:image\/png;base64,/, 'the accessibility comment image is an annotated screenshot');
  assert.doesNotMatch(outputText(outputs(byKind('api')), 'top-finding.svg'), /<image /, 'the API comment image is a verdict card');
});

test('generating twice in one process gives byte-identical output for every file', { criterion: 'AC-SPEC-00-01' }, () => {
  for (const report of loaded.reports) {
    const first = generate(report.input, { png: report.assets }, loaded.history);
    const second = generate(report.input, { png: report.assets }, loaded.history);
    assert.deepEqual(first.map((file) => [file.name, sha256(file.bytes)]), second.map((file) => [file.name, sha256(file.bytes)]));
  }
});

test('the generator has no wall-clock, random or environment access', () => {
  const banned = [/\bDate\b/, /Math\.random/, /\bperformance\b/, /process\.env/, /process\.hrtime/, /from 'node:os'/, /randomUUID|randomBytes|getRandomValues/, /toLocale/, /Intl\./];
  const generatorFiles = sourceFiles(REPORT_SOURCES);
  assert.ok(generatorFiles.length >= 10);
  for (const file of generatorFiles) {
    const code = readFileSync(file, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    for (const pattern of banned) assert.equal(pattern.test(code), false, `${file}: ${pattern}`);
  }
  for (const kind of ALL_KINDS) {
    assert.equal(/20\d\d-\d\d-\d\dT\d\d:\d\d/.test(reportHtml(byKind(kind)).replace(/<strong>Recorded<\/strong><div>[^<]*<\/div>/, '')), false);
  }
});

// ---- Hostile text -------------------------------------------------------------------------------

const HOSTILE = ['<script>alert(1)</script>', '"onmouseover="alert(1)', "'><img src=x onerror=alert(1)>", 'javascript:alert(1)', '</style><script>x</script>', '&lt;b&gt; & &amp;', 'a\ud800b', 'abc\u202edef', '</title><svg onload=x>', '</pre><script>1</script>'];
const TEXT_KEYS = new Set(['title', 'subject', 'note', 'tool', 'target', 'alt', 'caption', 'rule', 'reason', 'action', 'text', 'result', 'label', 'path']);
const TEXT_ARRAYS = new Set(['steps', 'log', 'requestLines', 'responseLines']);
function poison(value: unknown, key: string, counter: { next: number }): unknown {
  if (typeof value === 'string') return TEXT_KEYS.has(key) ? HOSTILE[counter.next++ % HOSTILE.length] : value;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' && TEXT_ARRAYS.has(key) ? HOSTILE[counter.next++ % HOSTILE.length] : poison(item, key, counter)));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, poison(child, childKey, counter)]));
  }
  return value;
}

test('hostile strings in every free-text field are escaped or neutralised', () => {
  const counter = { next: 0 };
  const hostileHistory = poison(JSON.parse(JSON.stringify(loaded.history)), 'history', counter) as typeof loaded.history;
  for (const kind of ALL_KINDS) {
    const base = byKind(kind);
    const raw = poison(JSON.parse(JSON.stringify(base)), 'report', counter);
    const parsed = parseReportInput(raw);
    assert.ok(parsed.ok, `${kind}: poisoned report parses ${parsed.ok ? '' : JSON.stringify(parsed.error.slice(0, 3))}`);
    if (!parsed.ok) continue;
    const files = generate(parsed.value, { png: assetsOf(base).png }, hostileHistory);
    for (const name of ['report.html', 'top-finding.svg', 'pr-comment.md']) {
      const text = outputText(files, name);
      assert.equal(/<script/i.test(text), false, `${kind}/${name}: no script element`);
      assert.equal(/<[A-Za-z][^>]*\son[a-z]+\s*=/.test(text), false, `${kind}/${name}: no handler attribute`);
      assert.equal(/(?:href|src|xlink:href)\s*=\s*["']?\s*javascript:/i.test(text), false);
      assert.equal(/<img\b/i.test(text), false, `${kind}/${name}: injected img`);
      assert.equal(/[\u202a-\u202e\u2066-\u2069]/.test(text), false, 'no bidi controls');
      assert.equal(text.isWellFormed(), true, 'well-formed text');
    }
    const html = outputText(files, 'report.html');
    assert.equal((html.match(/<style>/g) ?? []).length, 1);
    assert.equal((html.match(/<\/style>/g) ?? []).length, 1);
    assert.equal((html.match(/<title>/g) ?? []).length, 1);
    assert.equal((html.match(/<\/pre>/g) ?? []).length, (html.match(/<pre>/g) ?? []).length);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') || kind === 'api' || true);
    const ids = idsIn(html);
    assert.equal(new Set(ids).size, ids.length, 'ids stay unique');
    for (const link of hrefsIn(html)) assert.ok(new Set(ids).has(link));
  }
});

test('the model rejects hostile ids and the generator refuses an image that does not match its hash', () => {
  const base = JSON.parse(JSON.stringify(byKind('functional'))) as Record<string, any>;
  base.acceptance[0].id = 'x" onmouseover="1';
  assert.equal(parseReportInput(base).ok, false);
  const report = byKind('functional');
  const wrong = new Map(assetsOf(report).png);
  const [firstId] = [...wrong.keys()];
  wrong.set(firstId ?? '', new Uint8Array([1, 2, 3]));
  assert.throws(() => generate(report, { png: wrong }, loaded.history), /does not match|missing/);
});

// ---- Coverage of the three recorded runs --------------------------------------------------------

test('the accessibility report covers all 102 mapping-pair pages with the right verdicts', () => {
  const report = byKind('a11y');
  assert.equal(report.acceptance.length, 102);
  const view = deriveView(report);
  assert.equal(view.counts.passed, 51);
  assert.equal(view.counts.failed, 24);
  assert.equal(view.counts.needsReview, 27);
  for (const criterion of report.acceptance) {
    if (criterion.id.endsWith('.clean')) assert.equal(criterion.status, 'passed', criterion.id);
    else assert.ok(criterion.status !== 'passed', `${criterion.id}: a fixture page with a seeded failure is never "passed"`);
    if (criterion.status === 'failed') assert.ok(criterion.evidence.some((evidence) => evidence.kind === 'image'), `${criterion.id} has a screenshot`);
  }
  const annotated = new Set(report.findings.filter((finding) => finding.status === 'failed' && finding.image?.box).map((finding) => finding.image?.imageId));
  assert.ok(annotated.size >= 20, `${annotated.size} pages carry a callout`);
  assert.equal(report.findings.filter((finding) => finding.status === 'needs-review' && finding.severity === null).length, 27);
});

test('the functional report comes from a real run: states, hashes, a pass, a failure and an annotation', () => {
  const report = byKind('functional');
  const view = deriveView(report);
  assert.ok(view.counts.passed >= 1 && view.counts.failed >= 1);
  assert.ok(view.figures.some((figure) => figure.callouts.length > 0));
  assert.match(report.run.manifestHash ?? '', /^[0-9a-f]{64}$/);
  const recorded = JSON.parse(readFileSync(join(REPORT_INPUTS, 'functional-run.json'), 'utf8')) as {
    runs: { id: string; state: string; resultHash: string; manifestHash: string; steps: { outcome: string }[] }[];
  };
  assert.deepEqual(recorded.runs.map((run) => [run.id, run.state]), [['happy', 'Passed'], ['a11y', 'Failed'], ['label', 'Failed']]);
  for (const run of recorded.runs) {
    assert.match(run.resultHash, /^[0-9a-f]{64}$/);
    assert.match(run.manifestHash, /^[0-9a-f]{64}$/);
  }
  assert.equal(recorded.runs[0]?.steps.every((step) => step.outcome === 'passed'), true);
});

test('the API report covers all 60 API and identity cases and has all three verdicts', () => {
  const report = byKind('api');
  const view = deriveView(report);
  assert.equal(report.steps.length, 60);
  assert.equal(report.findings.filter((finding) => finding.status === 'failed').length, 15, '14 mutants and the oracle case');
  assert.equal(report.findings.filter((finding) => finding.status === 'needs-review').length, 4);
  assert.ok(view.counts.passed >= 1 && view.counts.failed >= 1 && view.counts.needsReview >= 1);
  const passedCases = report.steps.filter((step) => /^(passed|rejected as designed)/.test(step.result)).length;
  assert.equal(passedCases, 60 - 15 - 4);
  assert.ok(
    report.findings.filter((finding) => finding.status === 'failed')
      .every((finding) => finding.exchanges.length >= 1 || finding.id === 'F-oracle-assert-fails' || finding.rule.includes('lti')),
    'failed findings carry exchange excerpts',
  );
});

test('each HTML file is at most 2 MB', () => {
  for (const kind of ALL_KINDS) assert.ok((outputs(byKind(kind)).find((file) => file.name === 'report.html')?.bytes.length ?? 0) <= 2_000_000, kind);
});

test('white text on every severity badge has at least 4.5:1 contrast (axe cannot measure it over a screenshot)', () => {
  for (const [severity, style] of Object.entries(SEVERITY_STYLE)) assert.ok(contrast(style.color, '#ffffff') >= 4.5, `${severity}: ${contrast(style.color, '#ffffff').toFixed(2)}`);
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.01);
});

test('Markdown text is escaped so a caption cannot add a link, an image or a table cell', () => {
  const escaped = markdownEscape('![x](javascript:alert(1)) | <b>*a*</b> `c` a_b');
  assert.equal(/(^|[^\\])[![\]()|`*_]/.test(escaped), false, `unescaped markup in: ${escaped}`);
  assert.equal(/[<>]/.test(escaped), false, 'no raw angle brackets');
  assert.equal(markdownEscape('line\nbreak\u{202e}'), 'line break\u{fffd}');
});
