import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileNameMatchesExport } from '../../../tools/eslint/FileNameMatchesExport.ts';
import { lintWithRule } from './eslint-rule-harness.ts';

const findingsFor = (source: string, path: string): readonly string[] =>
  lintWithRule(fileNameMatchesExport, source, path).map((finding) => finding.messageId);

describe('Using the file name rule', () => {
  describe('given a source file', () => {
    describe('when its PascalCase name is an exported function in camelCase', () => {
      test('then it should pass', () => {
        assert.deepEqual(findingsFor('export function evaluatePolicy() {}', 'packages/engine/src/EvaluatePolicy.ts'), []);
      });
    });

    describe('when its name is the main export among several related exports', () => {
      test('then it should pass', () => {
        const source = 'export type PlanError = string; export class PlanParser {}';
        assert.deepEqual(findingsFor(source, 'packages/engine/src/PlanParser.ts'), []);
      });
    });

    describe('when its name is an exported interface, type or constant', () => {
      test('then it should pass for an interface', () => {
        assert.deepEqual(findingsFor('export interface PolicyGate {}', 'packages/engine/src/PolicyGate.ts'), []);
      });

      test('then it should pass for a type', () => {
        assert.deepEqual(findingsFor('export type Locale = string;', 'packages/contracts/src/Locale.ts'), []);
      });

      test('then it should pass for an UPPER_CASE constant', () => {
        assert.deepEqual(findingsFor('export const NAMING_LINT = 1;', 'tools/NamingLint.ts'), []);
      });
    });

    describe('when no export matches its name', () => {
      test('then it should report the mismatch', () => {
        assert.deepEqual(findingsFor('export function parsePlan() {}', 'packages/engine/src/PolicyGate.ts'), ['noMatchingExport']);
      });
    });

    describe('when it has no exports', () => {
      test('then it should only need a PascalCase name', () => {
        assert.deepEqual(findingsFor('console.log(1);', 'tools/InstallBrowsers.ts'), []);
      });
    });

    describe('when its name is kebab-case', () => {
      test('then it should report the file name', () => {
        assert.deepEqual(findingsFor('console.log(1);', 'packages/engine/src/plan-parser.ts'), ['fileNameCase']);
      });
    });

    describe('when its name carries a type suffix', () => {
      test('then it should report the file name', () => {
        assert.deepEqual(findingsFor('export function run() {}', 'packages/engine/src/Run.function.ts'), ['fileNameCase']);
      });
    });

    describe('when it sits in a folder that is not kebab-case', () => {
      test('then it should report the folder', () => {
        assert.deepEqual(findingsFor('export function run() {}', 'packages/engine/src/PlanParts/Run.ts'), ['folderCase']);
      });
    });
  });

  describe('given a package entry point', () => {
    describe('when it is named index.ts', () => {
      test('then it should pass whatever it exports', () => {
        assert.deepEqual(findingsFor('export function run() {}', 'packages/engine/src/index.ts'), []);
      });
    });
  });

  describe('given a test file', () => {
    describe('when it is named after its subject', () => {
      test('then it should pass', () => {
        assert.deepEqual(findingsFor('console.log(1);', 'test/unit/engine/PlanParser.test.ts'), []);
      });
    });

    describe('when it is split out by topic', () => {
      test('then it should pass', () => {
        assert.deepEqual(findingsFor('console.log(1);', 'test/unit/engine/PlanParser.Errors.test.ts'), []);
      });
    });

    describe('when it is kebab-case', () => {
      test('then it should report the file name', () => {
        assert.deepEqual(findingsFor('console.log(1);', 'test/unit/engine/plan-parser.test.ts'), ['fileNameCase']);
      });
    });
  });
});
