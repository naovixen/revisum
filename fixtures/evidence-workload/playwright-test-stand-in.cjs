#!/usr/local/bin/node
// A stand-in for Playwright Test's command line, installed as "playwright" in the fixture workload
// image (fixtures/evidence-workload/Dockerfile). It is not Playwright Test: it accepts the
// arguments Revisum appends (--retries, --reporter, --trace, --project), runs every *.spec.mjs
// module in its working folder, and writes a JSON report in Playwright Test's shape to the file
// PLAYWRIGHT_JSON_OUTPUT_NAME names. It exits with 1 when any test failed, as Playwright does.
//
// A spec module exports `describe`, its describe block's title, and `tests`, a list of
// { title, annotations?, run }. `run` is given the process's environment; a test fails when it
// throws, and its error message is the thrown error's.
// See docs/specs/SPEC-35-evidence-mode.md.
'use strict';
const { mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

// The Playwright version the report claims, as a real report's config.version does.
const REPORTED_VERSION = '1.56.1';

function readOptions(words) {
  const options = { projects: [], reporter: null, retries: null, trace: null };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const equals = word.indexOf('=');
    const flag = equals === -1 ? word : word.slice(0, equals);
    const value = () => (equals === -1 ? words[++index] : word.slice(equals + 1));
    if (flag === '--project') options.projects.push(value());
    else if (flag === '--reporter') options.reporter = value();
    else if (flag === '--retries') options.retries = value();
    else if (flag === '--trace') options.trace = value();
  }
  return options;
}

async function runTest(test, project, file) {
  const startTime = new Date().toISOString();
  const started = Date.now();
  let status = 'passed';
  const errors = [];
  try {
    await test.run({ environment: process.env });
  } catch (error) {
    status = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ message: `Error: ${message}`, location: { file: join(process.cwd(), file), line: 1, column: 1 } });
  }
  return {
    timeout: 30000,
    annotations: test.annotations ?? [],
    expectedStatus: 'passed',
    projectId: project,
    projectName: project,
    results: [{
      workerIndex: 0, parallelIndex: 0, status, duration: Date.now() - started, errors, stdout: [], stderr: [], retry: 0, startTime,
      annotations: [], attachments: [],
    }],
    status: status === 'passed' ? 'expected' : 'unexpected',
  };
}

async function main() {
  const [command, ...words] = process.argv.slice(2);
  if (command !== 'test') {
    console.error('this stand-in runs only "playwright test"');
    return 2;
  }
  const options = readOptions(words);
  const projects = options.projects.length === 0 ? ['chromium'] : options.projects;
  const files = readdirSync(process.cwd()).filter((name) => name.endsWith('.spec.mjs')).sort();
  const suites = [];
  let failed = 0;
  let passed = 0;
  for (const file of files) {
    const module = await import(pathToFileURL(join(process.cwd(), file)).href);
    const specs = [];
    for (const [index, test] of module.tests.entries()) {
      const entries = [];
      for (const project of projects) entries.push(await runTest(test, project, file));
      const ok = entries.every((entry) => entry.status === 'expected');
      for (const entry of entries) {
        if (entry.status === 'expected') passed++;
        else failed++;
      }
      specs.push({ title: test.title, ok, tags: [], tests: entries, id: `${file}-${index}`, file, line: index + 2, column: 3 });
    }
    suites.push({ title: file, file, line: 0, column: 0, specs: [], suites: [{ title: module.describe, file, line: 1, column: 1, specs }] });
  }
  const report = {
    config: {
      version: REPORTED_VERSION, workers: 1, rootDir: process.cwd(), metadata: {},
      projects: projects.map((name) => ({ id: name, name, retries: Number(options.retries ?? 0), outputDir: dirname(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? '.') })),
    },
    suites,
    errors: [],
    stats: { startTime: new Date().toISOString(), duration: 0, expected: passed, skipped: 0, unexpected: failed, flaky: 0 },
  };
  const outputName = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  if (options.reporter === 'json' && outputName !== undefined && outputName !== '') {
    mkdirSync(dirname(outputName), { recursive: true });
    writeFileSync(outputName, JSON.stringify(report));
  } else if (options.reporter === 'json') {
    process.stdout.write(JSON.stringify(report));
  }
  return failed > 0 ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 2; });
