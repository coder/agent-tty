import { describe, expect, it } from 'vitest';

import {
  buildLeakFindings,
  sanitizePromotedText,
  generateRunner,
  generateTape,
  parseHeroDemoArgs,
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

  it('generates a VHS tape with stable waits, a fixed review window, and cleanup', () => {
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
    expect(tape).toContain('Set Framerate 5');
    expect(tape).toContain('Sleep 120s');
    expect(tape).toContain('Ctrl+C');
    expect(tape).toContain('Type "/quit"');
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
      claudeEffort: 'medium',
    });
    expect(claudeRunner).toContain("--effort 'medium'");
    expect(claudeRunner).toContain('unset ANTHROPIC_API_KEY');
  });

  it('sanitizes promoted text before leak checking', () => {
    const sanitized = sanitizePromotedText(
      'Welcome back Alice!\nAPI Usage Billing\n/home/alice/project\nANTHROPIC_API_KEY\n',
    );
    expect(sanitized).not.toContain('Alice');
    expect(sanitized).not.toContain('API Usage Billing');
    expect(sanitized).not.toContain('/home/alice');
    expect(buildLeakFindings(sanitized)).toEqual([]);
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
