import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { testTitleFormat } from '../../../../tools/eslint/TestTitleFormat.ts';
import { lintWithRule } from './support/LintWithRule.ts';

const PATH = 'test/unit/engine/PlanParser.test.ts';
const findingsFor = (source: string): readonly string[] =>
  lintWithRule(testTitleFormat, source, PATH).map((finding) => finding.messageId);

describe('Using the test title rule', () => {
  describe('given the full title structure', () => {
    describe('when every level uses its keyword', () => {
      test('then it should pass', () => {
        const source = `describe('Using the parser', () => {
          describe('given a plan', () => {
            describe('and it has a target', () => {
              describe('when it is parsed', () => {
                test('then it should return the plan', () => {});
                describe('and it is parsed again', () => {
                  test('then it should return the same plan', () => {});
                });
              });
            });
          });
        });`;
        assert.deepEqual(findingsFor(source), []);
      });
    });
  });

  describe('given a subject with no state to set up', () => {
    describe('when the given level is skipped', () => {
      test('then it should pass', () => {
        const source = `describe('Using the clock', () => {
          describe('when it is read', () => { test('then it should return a time', () => {}); });
        });`;
        assert.deepEqual(findingsFor(source), []);
      });
    });
  });

  describe('given a criterion tag', () => {
    describe('when the test has an options argument', () => {
      test('then it should still read the title', () => {
        const source = `describe('Using the parser', () => {
          describe('when it is parsed', () => {
            test('then it should pass', { criterion: 'a criterion' }, () => {});
          });
        });`;
        assert.deepEqual(findingsFor(source), []);
      });
    });
  });

  describe('given a title built at run time', () => {
    describe('when it is a template that starts with the keyword', () => {
      test('then it should pass', () => {
        const source = `describe('Using the parser', () => {
          describe('when it is parsed', () => { test(\`then it should accept \${name}\`, () => {}); });
        });`;
        assert.deepEqual(findingsFor(source), []);
      });
    });

    describe('when it is a variable', () => {
      test('then it should not guess', () => {
        const source = `describe('Using the parser', () => {
          describe('when it is parsed', () => { test(title, () => {}); });
        });`;
        assert.deepEqual(findingsFor(source), []);
      });
    });
  });

  describe('given a broken structure', () => {
    describe('when the outermost describe does not start with Using', () => {
      test('then it should report it', () => {
        assert.deepEqual(findingsFor(`describe('the parser', () => {});`), ['outermostTitle']);
      });
    });

    describe('when a test is outside any describe', () => {
      test('then it should report it', () => {
        assert.deepEqual(findingsFor(`test('then it should pass', () => {});`), ['testOutsideDescribe']);
      });
    });

    describe('when a test title does not start with then it should', () => {
      test('then it should report it', () => {
        const source = `describe('Using the parser', () => {
          describe('when it is parsed', () => { test('returns the plan', () => {}); });
        });`;
        assert.deepEqual(findingsFor(source), ['testTitle']);
      });
    });

    describe('when a test has no action above it', () => {
      test('then it should report it', () => {
        const source = `describe('Using the parser', () => {
          describe('given a plan', () => { test('then it should pass', () => {}); });
        });`;
        assert.deepEqual(findingsFor(source), ['testWithoutAction']);
      });
    });

    describe('when a when sits inside another when', () => {
      test('then it should report it', () => {
        const source = `describe('Using the parser', () => {
          describe('when it is parsed', () => {
            describe('when it is parsed again', () => { test('then it should pass', () => {}); });
          });
        });`;
        assert.deepEqual(findingsFor(source), ['nestedTitle']);
      });
    });

    describe('when a given sits below another given', () => {
      test('then it should report it', () => {
        const source = `describe('Using the parser', () => {
          describe('given a plan', () => {
            describe('given a target', () => {
              describe('when it is parsed', () => { test('then it should pass', () => {}); });
            });
          });
        });`;
        assert.deepEqual(findingsFor(source), ['nestedTitle']);
      });
    });

    describe('when describes nest more than five levels deep', () => {
      test('then it should report the deepest one', () => {
        const source = `describe('Using the parser', () => {
          describe('given a', () => { describe('and b', () => { describe('and c', () => {
            describe('when d', () => { describe('and e', () => { test('then it should pass', () => {}); }); });
          }); }); });
        });`;
        assert.deepEqual(findingsFor(source), ['tooDeep']);
      });
    });
  });

  describe('given a call that is not a test', () => {
    describe('when another object has a test method', () => {
      test('then it should ignore it', () => {
        assert.deepEqual(findingsFor(`pattern.test('anything');`), []);
      });
    });
  });
});
