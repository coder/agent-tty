import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANTI_PATTERN_RULES,
  buildScannableTranscript,
  compileAntiPatternRegex,
  countAgentTtyCalls,
  detectAntiPatterns,
  filterRulesBySeverity,
  summarizeFindings,
} from '../../../evals/lib/antiPatterns.js';
import type {
  AntiPatternFinding,
  AntiPatternSeverity,
  NormalizedProviderOutput,
} from '../../../evals/lib/types.js';

function findByRule(transcript: string, ruleId: string): AntiPatternFinding[] {
  return detectAntiPatterns(transcript).filter(
    (finding) => finding.ruleId === ruleId,
  );
}

function makeFinding(
  ruleId: string,
  severity: AntiPatternSeverity,
): AntiPatternFinding {
  return {
    ruleId,
    severity,
    message: `${ruleId} ${severity}`,
  };
}

function createNormalizedOutput(
  overrides: Partial<NormalizedProviderOutput> = {},
): NormalizedProviderOutput {
  return {
    finalText: '',
    messages: [],
    referencedSkills: [],
    toolCalls: [],
    ...overrides,
  };
}

describe('DEFAULT_ANTI_PATTERN_RULES', () => {
  it('defines the canonical seven default rules in order', () => {
    expect(DEFAULT_ANTI_PATTERN_RULES).toHaveLength(7);
    expect(DEFAULT_ANTI_PATTERN_RULES.map((rule) => rule.id)).toEqual([
      'blind-sleep',
      'tmux-usage',
      'screen-usage',
      'adhoc-screenshot',
      'missing-json-flag',
      'orphaned-session',
      'direct-manifest-write',
    ]);
  });

  it('assigns the expected severity to each default rule', () => {
    expect(
      Object.fromEntries(
        DEFAULT_ANTI_PATTERN_RULES.map((rule) => [rule.id, rule.severity]),
      ),
    ).toEqual({
      'blind-sleep': 'error',
      'tmux-usage': 'error',
      'screen-usage': 'error',
      'adhoc-screenshot': 'error',
      'missing-json-flag': 'warning',
      'orphaned-session': 'warning',
      'direct-manifest-write': 'info',
    });
  });
});

describe('compileAntiPatternRegex', () => {
  it('compiles patterns with global and case-insensitive flags', () => {
    const regex = compileAntiPatternRegex(String.raw`sleep\s+\d+`);

    expect(regex.flags).toBe('gi');
    expect('SLEEP 5 and sleep 10'.match(regex)).toEqual([
      'SLEEP 5',
      'sleep 10',
    ]);
  });

  it('throws a descriptive error for invalid patterns', () => {
    expect(() => compileAntiPatternRegex('(')).toThrow(
      /Invalid anti-pattern regex pattern "\("/u,
    );
  });
});

describe('detectAntiPatterns', () => {
  describe('basic rules', () => {
    it('detects blind sleep on a plain line', () => {
      const findings = findByRule('sleep 5', 'blind-sleep');

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: 'blind-sleep',
        severity: 'error',
        matchedText: 'sleep 5',
        lineNumber: 1,
      });
    });

    it('skips blind sleep inside loop context', () => {
      expect(findByRule('while true; do sleep 5; done', 'blind-sleep')).toEqual(
        [],
      );
    });

    it('detects tmux usage', () => {
      const findings = findByRule('tmux new-session', 'tmux-usage');

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: 'tmux-usage',
        severity: 'error',
        matchedText: 'tmux new-session',
        lineNumber: 1,
      });
    });

    it('downgrades tmux usage in negation context to info', () => {
      const findings = findByRule(
        'instead of tmux, use agent-tty',
        'tmux-usage',
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: 'tmux-usage',
        severity: 'info',
        matchedText: 'tmux',
      });
      expect(findings.some((finding) => finding.severity === 'error')).toBe(
        false,
      );
    });

    it('downgrades blind sleep in negation context instead of emitting an error', () => {
      const findings = findByRule(
        'avoid time.sleep(5) and use agent-tty wait instead',
        'blind-sleep',
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: 'blind-sleep',
        severity: 'info',
        matchedText: 'time.sleep(5)',
      });
      expect(findings.some((finding) => finding.severity === 'error')).toBe(
        false,
      );
    });

    it('returns no findings for a clean agent-tty transcript with --json', () => {
      const transcript = [
        'agent-tty create --json --session demo',
        'agent-tty destroy --json --session demo',
      ].join('\n');

      expect(detectAntiPatterns(transcript)).toEqual([]);
    });
  });

  describe('missing-json-flag', () => {
    it('flags agent-tty commands without --json', () => {
      const findings = findByRule(
        [
          'agent-tty create --session demo',
          'agent-tty destroy --session demo',
        ].join('\n'),
        'missing-json-flag',
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: 'missing-json-flag',
        severity: 'warning',
        matchedText: 'agent-tty create --session demo',
        lineNumber: 1,
      });
    });

    it('does not flag agent-tty commands that include --json', () => {
      const findings = findByRule(
        [
          'agent-tty create --json --session demo',
          'agent-tty destroy --json --session demo',
        ].join('\n'),
        'missing-json-flag',
      );

      expect(findings).toEqual([]);
    });

    it('emits info-level finding when some commands have --json and others do not', () => {
      const findings = findByRule(
        [
          'agent-tty create --session demo',
          'agent-tty destroy --json --session demo',
        ].join('\n'),
        'missing-json-flag',
      );

      expect(findings).toEqual([
        {
          ruleId: 'missing-json-flag',
          severity: 'info',
          message:
            'Informational only: some agent-tty commands omitted --json even though other commands included it. Missing --json on create (line 1).',
          matchedText: 'agent-tty create --session demo',
          lineNumber: 1,
          suggestedFix:
            'Add --json to agent-tty commands used in transcripts, evals, or automation so downstream parsing is stable.',
        },
      ]);
    });

    it('does not emit when there are no agent-tty commands', () => {
      expect(findByRule('echo ready', 'missing-json-flag')).toEqual([]);
    });
  });

  describe('orphaned-session', () => {
    it('does not report sessions that are created and destroyed', () => {
      const findings = findByRule(
        [
          'agent-tty create --json --session demo',
          'agent-tty destroy --json --session demo',
        ].join('\n'),
        'orphaned-session',
      );

      expect(findings).toEqual([]);
    });

    it('reports sessions that are created without destroy cleanup', () => {
      const findings = findByRule(
        'agent-tty create --json --session demo',
        'orphaned-session',
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: 'orphaned-session',
        severity: 'warning',
        lineNumber: 1,
      });
      expect(findings[0]?.matchedText).toContain('session demo');
    });

    it('does not report multiple sessions when each one is destroyed', () => {
      const findings = findByRule(
        [
          'agent-tty create --json --session alpha',
          'agent-tty create --json --session beta',
          'agent-tty destroy --json --session beta',
          'agent-tty destroy --json --session alpha',
        ].join('\n'),
        'orphaned-session',
      );

      expect(findings).toEqual([]);
    });

    it('skips comment-only lines before scanning for violations', () => {
      const transcript = [
        '# agent-tty create --session demo',
        '// tmux new-session',
        '/* sleep 5 */',
        '* screen -ls',
        '*/ agent-tty destroy --session demo',
        '<!-- gnome-screenshot -->',
      ].join('\n');

      expect(detectAntiPatterns(transcript)).toEqual([]);
    });
  });

  describe('line numbers and ordering', () => {
    it('returns correct line numbers for multiple violations', () => {
      const findings = detectAntiPatterns(
        ['tmux new-session', 'echo ready', 'sleep 5'].join('\n'),
      );

      expect(
        findings.map((finding) => [finding.ruleId, finding.lineNumber]),
      ).toEqual([
        ['tmux-usage', 1],
        ['blind-sleep', 3],
      ]);
    });

    it('sorts findings by line number and then rule id', () => {
      const findings = detectAntiPatterns(
        ['agent-tty create --session demo', 'tmux new-session'].join('\n'),
      );

      expect(
        findings.map((finding) => [finding.ruleId, finding.lineNumber]),
      ).toEqual([
        ['missing-json-flag', 1],
        ['orphaned-session', 1],
        ['tmux-usage', 2],
      ]);
    });
  });
});

describe('filterRulesBySeverity', () => {
  it('keeps warning and error rules for a warning threshold', () => {
    expect(
      filterRulesBySeverity(DEFAULT_ANTI_PATTERN_RULES, 'warning').map(
        (rule) => rule.id,
      ),
    ).toEqual([
      'blind-sleep',
      'tmux-usage',
      'screen-usage',
      'adhoc-screenshot',
      'missing-json-flag',
      'orphaned-session',
    ]);
  });

  it('keeps only error rules for an error threshold', () => {
    expect(
      filterRulesBySeverity(DEFAULT_ANTI_PATTERN_RULES, 'error').map(
        (rule) => rule.id,
      ),
    ).toEqual([
      'blind-sleep',
      'tmux-usage',
      'screen-usage',
      'adhoc-screenshot',
    ]);
  });
});

describe('summarizeFindings', () => {
  it('counts totals by severity for a mixed set of findings', () => {
    expect(
      summarizeFindings([
        makeFinding('blind-sleep', 'error'),
        makeFinding('tmux-usage', 'error'),
        makeFinding('missing-json-flag', 'warning'),
        makeFinding('direct-manifest-write', 'info'),
      ]),
    ).toEqual({
      total: 4,
      byRule: {
        'blind-sleep': 1,
        'tmux-usage': 1,
        'missing-json-flag': 1,
        'direct-manifest-write': 1,
      },
      bySeverity: {
        info: 1,
        warning: 1,
        error: 2,
      },
    });
  });

  it('counts totals by rule across repeated findings', () => {
    expect(
      summarizeFindings([
        makeFinding('tmux-usage', 'error'),
        makeFinding('tmux-usage', 'error'),
        makeFinding('orphaned-session', 'warning'),
      ]),
    ).toEqual({
      total: 3,
      byRule: {
        'tmux-usage': 2,
        'orphaned-session': 1,
      },
      bySeverity: {
        info: 0,
        warning: 1,
        error: 2,
      },
    });
  });
});

describe('buildScannableTranscript', () => {
  it('includes only bash/shell tool call content', () => {
    const normalized = createNormalizedOutput({
      finalText: 'Some planning text about tmux and sleep',
      messages: ['Use agent-tty instead of tmux'],
      referencedSkills: ['agent-tty'],
      toolCalls: [
        {
          name: 'bash',
          input: { script: 'agent-tty create --json --session demo' },
          output: { stdout: 'session created' },
        },
        {
          name: 'read_file',
          input: { path: '/tmp/test.txt' },
          output: { content: 'file contents' },
        },
        {
          name: 'Bash',
          input: { script: 'agent-tty snapshot --json --session demo' },
          output: { stdout: 'snapshot taken' },
        },
      ],
    });

    const transcript = buildScannableTranscript(normalized);

    expect(transcript).toContain('agent-tty create');
    expect(transcript).toContain('agent-tty snapshot');
    expect(transcript).not.toContain('tmux');
    expect(transcript).not.toContain('sleep');
    expect(transcript).not.toContain('read_file');
    expect(transcript).not.toContain('file contents');
  });

  it('includes unnamed Codex command execution records', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [
        {
          type: 'command_execution',
          command: 'npx tsx src/cli/main.ts wait --json --session demo',
          aggregated_output: 'wait completed',
        },
      ],
    });

    const transcript = buildScannableTranscript(normalized);

    expect(transcript).toContain(
      'npx tsx src/cli/main.ts wait --json --session demo',
    );
    expect(transcript).toContain('wait completed');
  });

  it('returns empty string when toolCalls is empty', () => {
    expect(buildScannableTranscript(createNormalizedOutput())).toBe('');
  });

  it('returns empty string when no tool calls are shell-like', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [{ name: 'read_file', input: { path: '/foo' } }],
    });

    expect(buildScannableTranscript(normalized)).toBe('');
  });

  it('handles malformed tool call records defensively', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [
        { name: 'bash' },
        {},
        { name: 123 },
        { name: 'bash', input: 'raw string' },
      ],
    });

    expect(() => buildScannableTranscript(normalized)).not.toThrow();
    expect(typeof buildScannableTranscript(normalized)).toBe('string');
  });

  it('preserves ordering of tool calls', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [
        { name: 'bash', input: { script: 'first command' } },
        { name: 'bash', input: { script: 'second command' } },
      ],
    });

    const transcript = buildScannableTranscript(normalized);
    const firstIndex = transcript.indexOf('first command');
    const secondIndex = transcript.indexOf('second command');

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });
});

describe('countAgentTtyCalls', () => {
  it('counts tool calls that invoke agent-tty commands', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [
        {
          name: 'bash',
          input: { script: 'agent-tty create --json --session demo' },
        },
        { name: 'bash', input: { script: 'echo hello' } },
        {
          name: 'bash',
          input: {
            script: 'npx tsx src/cli/main.ts snapshot --json --session demo',
          },
        },
      ],
    });

    expect(countAgentTtyCalls(normalized)).toBe(2);
  });

  it('counts unnamed Codex shell records using output text when needed', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [
        {
          type: 'command_execution',
          output: {
            stdout:
              'executed npx tsx src/cli/main.ts snapshot --json --session demo',
          },
        },
      ],
    });

    expect(countAgentTtyCalls(normalized)).toBe(1);
  });

  it('returns 0 when no tool calls mention agent-tty', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [{ name: 'bash', input: { script: 'echo hello' } }],
    });

    expect(countAgentTtyCalls(normalized)).toBe(0);
  });

  it('returns 0 for empty toolCalls', () => {
    expect(countAgentTtyCalls(createNormalizedOutput())).toBe(0);
  });

  it('ignores non-shell tool calls even if input mentions agent-tty', () => {
    const normalized = createNormalizedOutput({
      toolCalls: [
        { name: 'read_file', input: { path: 'agent-tty/config.json' } },
      ],
    });

    expect(countAgentTtyCalls(normalized)).toBe(0);
  });
});
