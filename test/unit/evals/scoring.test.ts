import { describe, expect, it } from 'vitest';

import {
  PASS_THRESHOLD,
  checkForbiddenPatterns,
  checkWorkflow,
  compilePattern,
  computePrecisionRecall,
  isInNegationContext,
  matchPatterns,
  scorePromptCase,
} from '../../../evals/lib/scoring.js';
import type {
  AntiPatternRule,
  PromptEvalCase,
  WorkflowCheck,
} from '../../../evals/lib/types.js';

function createPromptEvalCase(
  overrides: Partial<PromptEvalCase> = {},
): PromptEvalCase {
  return {
    id: 'test-case',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Test prompt',
    expectedSkill: 'agent-tty',
    expectedPatterns: [],
    forbiddenPatterns: [],
    rubric: [],
    workflowChecks: [],
    antiPatterns: [],
    budgets: { timeoutMs: 5000 },
    ...overrides,
  };
}

function createWorkflowCheck(
  overrides: Partial<WorkflowCheck> = {},
): WorkflowCheck {
  return {
    id: 'wf-check',
    description: 'Test workflow check',
    required: true,
    requiredPatterns: [],
    forbiddenPatterns: [],
    dependsOn: [],
    ...overrides,
  };
}

function createAntiPatternRule(
  overrides: Partial<AntiPatternRule> = {},
): AntiPatternRule {
  return {
    id: 'anti-pattern',
    description: 'Avoid this pattern',
    severity: 'warning',
    patterns: [],
    suggestedFix: 'Use a safer workflow',
    ...overrides,
  };
}

function getFirstResult<T>(results: T[], label: string): T {
  const result = results[0];
  if (result === undefined) {
    throw new Error(`Expected a result for ${label}`);
  }

  return result;
}

function getWorkflowResult(
  results: ReturnType<typeof checkWorkflow>,
  checkId: string,
) {
  const result = results.find((candidate) => candidate.checkId === checkId);
  if (result === undefined) {
    throw new Error(`Expected workflow result for check ${checkId}`);
  }

  return result;
}

describe('compilePattern', () => {
  it('parses regex literals with flags', () => {
    const pattern = compilePattern('/foo/i');

    expect(pattern.source).toBe('foo');
    expect(pattern.flags).toBe('i');
    expect(pattern.test('FOO')).toBe(true);
  });

  it('compiles plain strings as regex sources', () => {
    const pattern = compilePattern('agent-tty');

    expect(pattern.source).toBe('agent-tty');
    expect(pattern.flags).toBe('');
    expect(pattern.test('agent-tty')).toBe(true);
  });

  it('returns the cached RegExp instance for repeated sources', () => {
    const first = compilePattern('cached-pattern');
    const second = compilePattern('cached-pattern');

    expect(second).toBe(first);
  });

  it('throws a descriptive error for invalid regex sources', () => {
    expect(() => compilePattern('/[/')).toThrow(/Invalid regex pattern/u);
  });
});

describe('matchPatterns', () => {
  it('returns matched text and line number for a single pattern', () => {
    const result = getFirstResult(
      matchPatterns('Use agent-tty here', ['agent-tty']),
      'single expected-pattern match',
    );

    expect(result).toEqual({
      pattern: 'agent-tty',
      matched: true,
      matchedTexts: ['agent-tty'],
      lineNumbers: [1],
      matchCount: 1,
    });
  });

  it('collects multiple matches across lines with 1-based line numbers', () => {
    const text = 'first line\nagent-tty second\nthird\nagent-tty fourth';
    const result = getFirstResult(
      matchPatterns(text, ['agent-tty']),
      'multi-line expected-pattern match',
    );

    expect(result.matched).toBe(true);
    expect(result.matchedTexts).toEqual(['agent-tty', 'agent-tty']);
    expect(result.lineNumbers).toEqual([2, 4]);
    expect(result.matchCount).toBe(2);
  });

  it('returns unmatched results when a pattern does not appear', () => {
    const result = getFirstResult(
      matchPatterns('Use agent-tty here', ['tmux']),
      'missing expected-pattern match',
    );

    expect(result).toEqual({
      pattern: 'tmux',
      matched: false,
      matchedTexts: [],
      lineNumbers: [],
      matchCount: 0,
    });
  });

  it('returns no matches for empty text with non-empty patterns', () => {
    const result = getFirstResult(
      matchPatterns('', ['agent-tty']),
      'empty-text expected-pattern match',
    );

    expect(result.matched).toBe(false);
    expect(result.matchedTexts).toEqual([]);
    expect(result.lineNumbers).toEqual([]);
    expect(result.matchCount).toBe(0);
  });

  it('tracks line numbers correctly for multiple patterns in the same text', () => {
    const text = 'agent-tty\nalpha\nsnapshot\nbeta\nagent-tty';
    const results = matchPatterns(text, ['agent-tty', 'snapshot']);

    expect(results).toEqual([
      {
        pattern: 'agent-tty',
        matched: true,
        matchedTexts: ['agent-tty', 'agent-tty'],
        lineNumbers: [1, 5],
        matchCount: 2,
      },
      {
        pattern: 'snapshot',
        matched: true,
        matchedTexts: ['snapshot'],
        lineNumbers: [3],
        matchCount: 1,
      },
    ]);
  });
});

describe('checkForbiddenPatterns', () => {
  it('reports violations outside negation contexts', () => {
    const result = getFirstResult(
      checkForbiddenPatterns('Run tmux new-session\nthen tmux attach', [
        'tmux',
      ]),
      'forbidden-pattern violation',
    );

    expect(result).toEqual({
      pattern: 'tmux',
      violated: true,
      matchedTexts: ['tmux', 'tmux'],
      lineNumbers: [1, 2],
      matchCount: 2,
    });
  });

  it('returns no violations when the forbidden pattern does not match', () => {
    const result = getFirstResult(
      checkForbiddenPatterns('Use agent-tty only', ['tmux']),
      'missing forbidden-pattern match',
    );

    expect(result).toEqual({
      pattern: 'tmux',
      violated: false,
      matchedTexts: [],
      lineNumbers: [],
      matchCount: 0,
    });
  });

  it('ignores forbidden matches that only appear in a negation context', () => {
    const result = getFirstResult(
      checkForbiddenPatterns('Use agent-tty instead of tmux', ['tmux']),
      'negated forbidden-pattern match',
    );

    expect(result.violated).toBe(false);
    expect(result.matchedTexts).toEqual([]);
    expect(result.lineNumbers).toEqual([]);
    expect(result.matchCount).toBe(0);
    expect(result.note).toContain(
      'Ignored 1 forbidden-pattern match in negation context',
    );
  });

  it('counts only non-negated matches when both negated and actual violations exist', () => {
    const result = getFirstResult(
      checkForbiddenPatterns(
        [
          'Use agent-tty instead of tmux.',
          'This explanation is intentionally long enough to push the next use outside the negation window.',
          'Then run tmux new-session.',
        ].join('\n'),
        ['tmux'],
      ),
      'mixed forbidden-pattern matches',
    );

    expect(result.violated).toBe(true);
    expect(result.matchedTexts).toEqual(['tmux']);
    expect(result.lineNumbers).toEqual([3]);
    expect(result.matchCount).toBe(1);
    expect(result.note).toContain(
      'Ignored 1 forbidden-pattern match in negation context while counting actual violations.',
    );
  });

  it('returns an empty result set for an empty pattern list', () => {
    expect(checkForbiddenPatterns('Use agent-tty only', [])).toEqual([]);
  });
});

describe('isInNegationContext', () => {
  it('detects "instead of" negation contexts', () => {
    const text = 'Use agent-tty instead of tmux';

    expect(isInNegationContext(text, text.indexOf('tmux'))).toBe(true);
  });

  it('detects "don\'t use" negation contexts', () => {
    const text = "Please don't use sleep in this workflow";

    expect(isInNegationContext(text, text.indexOf('sleep'))).toBe(true);
  });

  it('detects "avoid" negation contexts', () => {
    const text = 'avoid screen sessions for this task';

    expect(isInNegationContext(text, text.indexOf('screen'))).toBe(true);
  });

  it('does not flag positive usage as negation context', () => {
    const text = 'run tmux new-session';

    expect(isInNegationContext(text, text.indexOf('tmux'))).toBe(false);
  });

  it('returns false when the match is at the start of the text', () => {
    expect(isInNegationContext('tmux is mentioned first', 0)).toBe(false);
  });
});

describe('PASS_THRESHOLD', () => {
  it('matches the documented pass threshold', () => {
    expect(PASS_THRESHOLD).toBe(0.6);
  });
});

describe('scorePromptCase', () => {
  it('returns a perfect score when all criteria are satisfied', () => {
    const evalCase = createPromptEvalCase({
      expectedPatterns: ['agent-tty', 'snapshot'],
      workflowChecks: [
        createWorkflowCheck({
          id: 'verify-step',
          requiredPatterns: ['verify'],
        }),
      ],
    });
    const response =
      'Use agent-tty to capture a snapshot and verify the output.';

    const result = scorePromptCase(response, evalCase);

    expect(result.expectedSkillCorrect).toBe(true);
    expect(result.breakdown.total).toBe(1);
    expect(result.breakdown.maxPossible).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.patternMatches.every((match) => match.matched)).toBe(true);
    expect(result.workflowChecks.every((check) => check.passed)).toBe(true);
    expect(result.forbiddenPatternMatches).toEqual([]);
    expect(result.antiPatternFindings).toEqual([]);
  });

  it('returns a zero score when nothing matches and the wrong skill is inferred', () => {
    const evalCase = createPromptEvalCase({
      expectedPatterns: ['agent-tty'],
    });
    const response = 'Switch to dogfood-tui for this review.';

    const result = scorePromptCase(response, evalCase);

    expect(result.expectedSkillCorrect).toBe(false);
    expect(result.patternMatches[0]?.matched).toBe(false);
    expect(result.breakdown.total).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('returns a partial score when only some expected patterns match', () => {
    const evalCase = createPromptEvalCase({
      expectedPatterns: ['snapshot', 'wait'],
      workflowChecks: [
        createWorkflowCheck({
          id: 'capture-proof',
          requiredPatterns: ['snapshot'],
        }),
      ],
    });
    const response = 'Use agent-tty and capture a snapshot before responding.';

    const result = scorePromptCase(response, evalCase);

    expect(result.expectedSkillCorrect).toBe(true);
    expect(result.patternMatches.map((match) => match.matched)).toEqual([
      true,
      false,
    ]);
    expect(result.breakdown.total).toBeCloseTo(0.8, 10);
    expect(result.passed).toBe(true);
  });

  it('subtracts forbidden pattern penalties from the positive score', () => {
    const evalCase = createPromptEvalCase({
      expectedPatterns: ['agent-tty', 'snapshot'],
      forbiddenPatterns: ['tmux'],
      workflowChecks: [
        createWorkflowCheck({
          id: 'capture-proof',
          requiredPatterns: ['snapshot'],
        }),
      ],
    });
    const response =
      'Use agent-tty and capture a snapshot. Then run tmux new-session.';

    const result = scorePromptCase(response, evalCase);

    expect(result.forbiddenPatternMatches[0]?.violated).toBe(true);
    expect(result.breakdown.total).toBeCloseTo(0.9, 10);
    expect(result.passed).toBe(true);
  });

  it('subtracts anti-pattern penalties for each finding', () => {
    const evalCase = createPromptEvalCase({
      expectedPatterns: ['agent-tty'],
      workflowChecks: [
        createWorkflowCheck({
          id: 'capture-proof',
          requiredPatterns: ['snapshot'],
        }),
      ],
      antiPatterns: [
        createAntiPatternRule({
          id: 'fixed-sleeps',
          description: 'Avoid fixed sleeps',
          patterns: ['sleep'],
          suggestedFix: 'Use wait commands',
        }),
      ],
    });
    const response =
      'Use agent-tty and capture a snapshot, but sleep 1 before checking.';

    const result = scorePromptCase(response, evalCase);

    expect(result.antiPatternFindings).toHaveLength(1);
    expect(result.antiPatternFindings[0]).toMatchObject({
      ruleId: 'fixed-sleeps',
      severity: 'warning',
      matchedText: 'sleep',
      lineNumber: 1,
      suggestedFix: 'Use wait commands',
    });
    expect(result.breakdown.total).toBeCloseTo(0.95, 10);
    expect(result.passed).toBe(true);
  });

  it('requires both threshold score and correct skill to pass', () => {
    const evalCase = createPromptEvalCase({
      expectedPatterns: ['snapshot'],
      workflowChecks: [
        createWorkflowCheck({
          id: 'capture-proof',
          requiredPatterns: ['snapshot'],
        }),
      ],
    });
    const response = 'Use dogfood-tui and take a snapshot.';

    const result = scorePromptCase(response, evalCase);

    expect(result.expectedSkillCorrect).toBe(false);
    expect(result.breakdown.total).toBeCloseTo(PASS_THRESHOLD, 10);
    expect(result.passed).toBe(false);
  });
});

describe('computePrecisionRecall', () => {
  it('returns perfect precision, recall, and F1 for all true positives', () => {
    const result = computePrecisionRecall([
      { expected: true, actual: true },
      { expected: true, actual: true },
    ]);

    expect(result).toEqual({ precision: 1, recall: 1, f1: 1 });
  });

  it('returns zeros when every positive prediction is a false positive', () => {
    const result = computePrecisionRecall([
      { expected: false, actual: true },
      { expected: false, actual: true },
    ]);

    expect(result).toEqual({ precision: 0, recall: 0, f1: 0 });
  });

  it('computes mixed precision, recall, and F1 correctly', () => {
    const result = computePrecisionRecall([
      { expected: true, actual: true },
      { expected: true, actual: false },
      { expected: false, actual: true },
      { expected: false, actual: false },
    ]);

    expect(result.precision).toBeCloseTo(0.5, 10);
    expect(result.recall).toBeCloseTo(0.5, 10);
    expect(result.f1).toBeCloseTo(0.5, 10);
  });

  it('returns zeros for empty input', () => {
    expect(computePrecisionRecall([])).toEqual({
      precision: 0,
      recall: 0,
      f1: 0,
    });
  });
});

describe('checkWorkflow', () => {
  it('passes checks when required patterns match and no forbidden patterns are hit', () => {
    const checks = [
      createWorkflowCheck({
        id: 'load-skill',
        requiredPatterns: ['agent-tty'],
      }),
      createWorkflowCheck({
        id: 'capture-proof',
        requiredPatterns: ['snapshot'],
        dependsOn: ['load-skill'],
      }),
    ];

    const results = checkWorkflow(
      'Use agent-tty first and then capture a snapshot.',
      checks,
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('fails a check when a required pattern is missing', () => {
    const results = checkWorkflow('Use agent-tty only.', [
      createWorkflowCheck({
        id: 'capture-proof',
        requiredPatterns: ['snapshot'],
      }),
    ]);
    const result = getWorkflowResult(results, 'capture-proof');

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Missing required patterns: snapshot');
    expect(result.matches[0]).toMatchObject({
      pattern: 'snapshot',
      matched: false,
    });
  });

  it('fails dependent checks when their dependency fails', () => {
    const checks = [
      createWorkflowCheck({
        id: 'load-skill',
        requiredPatterns: ['agent-tty'],
      }),
      createWorkflowCheck({
        id: 'capture-proof',
        requiredPatterns: ['snapshot'],
        dependsOn: ['load-skill'],
      }),
    ];

    const results = checkWorkflow('Capture a snapshot only.', checks);
    const dependencyResult = getWorkflowResult(results, 'load-skill');
    const dependentResult = getWorkflowResult(results, 'capture-proof');

    expect(dependencyResult.passed).toBe(false);
    expect(dependencyResult.message).toContain(
      'Missing required patterns: agent-tty',
    );
    expect(dependentResult.passed).toBe(false);
    expect(dependentResult.message).toContain(
      'Dependency "load-skill" did not pass',
    );
  });

  it('fails a workflow check when it matches a forbidden pattern', () => {
    const results = checkWorkflow(
      'Use agent-tty but also run tmux new-session.',
      [
        createWorkflowCheck({
          id: 'avoid-tmux',
          requiredPatterns: ['agent-tty'],
          forbiddenPatterns: ['tmux'],
        }),
      ],
    );
    const result = getWorkflowResult(results, 'avoid-tmux');

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Matched forbidden patterns: tmux');
    expect(result.forbiddenMatches[0]).toMatchObject({
      pattern: 'tmux',
      violated: true,
      matchCount: 1,
    });
  });
});
