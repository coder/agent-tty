import { describe, expect, it } from 'vitest';

import { ClaudeProvider } from '../../../evals/providers/claude.js';

function toJsonLines(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('ClaudeProvider.parse', () => {
  it('normalizes complete JSON usage objects and prefers the last valid record', () => {
    const provider = new ClaudeProvider();
    const raw = toJsonLines([
      {
        type: 'assistant',
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          total_tokens: 25,
          cache_read_input_tokens: 4,
        },
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'working' }],
        },
      },
      {
        type: 'result',
        result: 'done',
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          total_tokens: 165,
          cache_read_input_tokens: 60,
          service_tier: 'standard',
        },
      },
    ]);

    const normalized = provider.parse(raw);

    expect(normalized.finalText).toBe('done');
    expect(normalized.tokenUsage).toStrictEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      cachedTokens: 60,
    });
  });

  it.each([
    {
      name: 'missing total_tokens',
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        cache_read_input_tokens: 60,
      },
    },
    {
      name: 'fractional totals',
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        total_tokens: 165.5,
        cache_read_input_tokens: 60,
      },
    },
    {
      name: 'negative cached tokens',
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        total_tokens: 165,
        cache_read_input_tokens: -1,
      },
    },
  ])('omits tokenUsage for $name', ({ usage }) => {
    const provider = new ClaudeProvider();
    const raw = toJsonLines([
      {
        type: 'result',
        result: 'done',
        usage,
      },
    ]);

    const normalized = provider.parse(raw);

    expect(normalized.tokenUsage).toBeUndefined();
  });

  it('does not emit tokenUsage for plain-text output', () => {
    const provider = new ClaudeProvider();

    const normalized = provider.parse('Assistant: done');

    expect(normalized.tokenUsage).toBeUndefined();
  });
});
