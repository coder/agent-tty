import { describe, expect, it } from 'vitest';

import {
  buildLeakFindings,
  sanitizePromotedText,
  generateRunner,
  generateTape,
  parseHeroDemoArgs,
  selectPromotionRuns,
  selectedAgents,
} from '../../../src/tools/hero-demo.js';

describe('hero demo generator planning', () => {
  it('requires promotion to run both agents at least three times', () => {
    expect(() => parseHeroDemoArgs(['--promote', '--runs', '2'])).toThrow(
      '--promote requires --runs >= 3',
    );
    expect(() =>
      parseHeroDemoArgs(['--promote', '--runs', '3', '--agent', 'codex']),
    ).toThrow('--promote requires --agent both');

    const options = parseHeroDemoArgs(['--promote', '--runs', '3']);
    expect(options.promote).toBe(true);
    expect(options.runs).toBe(3);
    expect(selectedAgents(options.agent)).toEqual(['codex', 'claude']);
  });

  it('generates a Codex VHS tape with stable waits, a fixed review window, and cleanup', () => {
    const tape = generateTape({
      agent: 'codex',
      runnerPath: '/tmp/run-codex.sh',
      recordSeconds: 120,
    });

    expect(tape).toContain('Output outer.webm');
    expect(tape).toContain('Output outer.ascii');
    expect(tape).toContain(
      'Wait+Screen@120s /Do you trust|OpenAI Codex|Codex/',
    );
    expect(tape).toContain('Type "bash /tmp/run-codex.sh"');
    expect(tape).toContain('Set Width 1600');
    expect(tape).toContain('Set Height 900');
    expect(tape).toContain('Set FontSize 14');
    expect(tape).toContain('Set Framerate 5');
    expect(tape).toContain('Sleep 120s');
    expect(tape).toContain('Ctrl+C');
    expect(tape).toContain('Type "/quit"');
  });

  it('generates a Claude VHS tape with Claude-specific waits and cleanup', () => {
    const tape = generateTape({
      agent: 'claude',
      runnerPath: '/tmp/run-claude.sh',
      recordSeconds: 180,
    });

    expect(tape).toContain('Type "bash /tmp/run-claude.sh"');
    expect(tape).toContain(
      'Wait+Screen@120s /Quick safety check|Claude Code|Yes, I trust|Welcome/',
    );
    expect(tape).toContain(
      'Wait+Screen@120s /Claude Code|Welcome|esc to interrupt/',
    );
    expect(tape).toContain('Sleep 180s');
    expect(tape).toContain('Type "/exit"');
  });

  it('generates agent-specific runners with configurable model and effort', () => {
    const codexRunner = generateRunner({
      agent: 'codex',
      workspace: '/tmp/workspace',
      promptPath: '/tmp/prompt.md',
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
      finalFile: '/tmp/workspace/demo-note.txt',
      innerCast: '/tmp/workspace/artifacts/inner.cast',
      innerWebm: '/tmp/workspace/artifacts/inner.webm',
      expectedText: 'demo text',
      codexModel: 'gpt-demo',
      codexEffort: 'minimal',
      claudeModel: 'claude-demo',
      claudeEffort: 'low',
    });
    expect(codexRunner).toContain("--model 'gpt-demo'");
    expect(codexRunner).toContain("model_reasoning_effort='minimal'");
    expect(codexRunner).toContain('CODEX_DISABLE_UPDATE_CHECK=1');
    expect(codexRunner).toContain('AGENT_TTY_HOME');

    const claudeRunner = generateRunner({
      agent: 'claude',
      workspace: '/tmp/workspace',
      promptPath: '/tmp/prompt.md',
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
      finalFile: '/tmp/workspace/demo-note.txt',
      innerCast: '/tmp/workspace/artifacts/inner.cast',
      innerWebm: '/tmp/workspace/artifacts/inner.webm',
      expectedText: 'demo text',
      codexModel: 'gpt-demo',
      codexEffort: 'minimal',
      claudeModel: 'claude-demo',
      claudeEffort: 'medium',
    });
    expect(claudeRunner).toContain("--model 'claude-demo'");
    expect(claudeRunner).toContain("--effort 'medium'");
    for (const runner of [codexRunner, claudeRunner]) {
      expect(runner).toContain(
        "export HERO_FINAL_FILE='/tmp/workspace/demo-note.txt'",
      );
      expect(runner).toContain(
        "export HERO_INNER_CAST='/tmp/workspace/artifacts/inner.cast'",
      );
      expect(runner).toContain(
        "export HERO_INNER_WEBM='/tmp/workspace/artifacts/inner.webm'",
      );
      expect(runner).toContain("export HERO_EXPECTED_TEXT='demo text'");
    }
    expect(claudeRunner).toContain('unset ANTHROPIC_API_KEY');
  });

  it('selects the first passing promoted run per agent', () => {
    expect(
      selectPromotionRuns([
        { agent: 'codex', index: 1, passed: false },
        { agent: 'codex', index: 2, passed: true },
        { agent: 'codex', index: 3, passed: true },
        { agent: 'codex', index: 4, passed: true },
        { agent: 'claude', index: 1, passed: true },
        { agent: 'claude', index: 2, passed: false },
        { agent: 'claude', index: 3, passed: true },
        { agent: 'claude', index: 4, passed: true },
      ]),
    ).toEqual([
      { agent: 'codex', index: 2 },
      { agent: 'claude', index: 1 },
    ]);
  });

  it('rejects promotion when either agent has too few passing runs', () => {
    expect(() =>
      selectPromotionRuns([
        { agent: 'codex', index: 1, passed: true },
        { agent: 'codex', index: 2, passed: true },
        { agent: 'claude', index: 1, passed: true },
        { agent: 'claude', index: 2, passed: true },
        { agent: 'claude', index: 3, passed: true },
      ]),
    ).toThrow('codex only had 2 successful run(s)');
  });

  it('shell-quotes paths containing apostrophes in generated runners', () => {
    const runner = generateRunner({
      agent: 'claude',
      workspace: "/tmp/it's-fine",
      promptPath: '/tmp/prompt.md',
      installPrefix: '/tmp/install',
      innerHome: '/tmp/inner-home',
      finalFile: '/tmp/final.txt',
      innerCast: '/tmp/inner.cast',
      innerWebm: '/tmp/inner.webm',
      expectedText: 'demo text',
      codexModel: 'gpt-demo',
      codexEffort: 'minimal',
      claudeModel: 'claude-demo',
      claudeEffort: 'medium',
    });

    expect(runner).toContain("cd '/tmp/it'\\''s-fine'");
  });

  it('sanitizes promoted text before leak checking', () => {
    const sanitized = sanitizePromotedText(
      'Welcome back Alice\nAPI Usage Billing\n/home/alice/project\nANTHROPIC_API_KEY\n',
    );
    expect(sanitized).not.toContain('Alice');
    expect(sanitized).not.toContain('API Usage Billing');
    expect(sanitized).not.toContain('/home/alice');
    expect(buildLeakFindings(sanitized)).toEqual([]);
  });

  it('covers every account-sensitive leak pattern', () => {
    expect(
      buildLeakFindings(
        [
          '/Users/alice/project',
          'alice@example.invalid',
          'OPENAI_API_KEY',
          'Auth conflict detected',
          'tok_abcdefghijklmnop',
        ].join('\n'),
      ),
    ).toEqual([
      'absolute macOS home path',
      'email address',
      'OpenAI credential variable',
      'auth warning',
      'token-like secret',
    ]);
  });

  it('flags account-sensitive leakage but allows generic update text', () => {
    expect(
      buildLeakFindings('Update available! Run mise upgrade claude'),
    ).toEqual([]);
    expect(
      buildLeakFindings(
        'Welcome back Alice!\nAPI Usage Billing\n/home/alice/project\nANTHROPIC_API_KEY',
      ),
    ).toEqual([
      'absolute Linux home path',
      'Anthropic credential variable',
      'account/billing line',
      'account greeting',
    ]);
  });
});
