import { describe, expect, it } from 'vitest';

import {
  buildScannableTranscript,
  countAgentTtyCalls,
} from '../../../evals/lib/antiPatterns.js';
import { CodexProvider } from '../../../evals/providers/codex.js';

function toJsonLines(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('CodexProvider.parse', () => {
  it('normalizes command_execution items into shell-style tool calls', () => {
    const provider = new CodexProvider();
    const raw = toJsonLines([
      { type: 'thread.started', thread_id: 'thread_123' },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'npx tsx src/cli/main.ts snapshot --json --session demo',
          aggregated_output: 'snapshot ready\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'agent_message',
          text: 'done',
        },
      },
    ]);

    const normalized = provider.parse(raw);

    expect(normalized.toolCalls).toHaveLength(1);
    expect(normalized.toolCalls[0]).toMatchObject({
      id: 'item_1',
      type: 'command_execution',
      name: 'shell',
      input: {
        command: 'npx tsx src/cli/main.ts snapshot --json --session demo',
      },
      output: {
        stdout: 'snapshot ready\n',
        exitCode: 0,
        status: 'completed',
      },
    });
    expect(buildScannableTranscript(normalized)).toContain(
      'npx tsx src/cli/main.ts snapshot --json --session demo',
    );
    expect(buildScannableTranscript(normalized)).not.toContain(
      'snapshot ready',
    );
    expect(countAgentTtyCalls(normalized)).toBe(1);
  });

  it('normalizes function_call records with parsed arguments and outputs', () => {
    const provider = new CodexProvider();
    const raw = toJsonLines([
      {
        type: 'function_call',
        name: 'shell',
        call_id: 'call_1',
        arguments: JSON.stringify({
          command: [
            'npx',
            'tsx',
            'src/cli/main.ts',
            'run',
            '--json',
            '--session',
            'demo',
          ],
        }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'command finished',
      },
      {
        type: 'agent_message',
        text: 'done',
      },
    ]);

    const normalized = provider.parse(raw);

    expect(normalized.toolCalls).toHaveLength(1);
    expect(normalized.toolCalls[0]).toMatchObject({
      call_id: 'call_1',
      name: 'shell',
      input: {
        command: 'npx tsx src/cli/main.ts run --json --session demo',
      },
      output: 'command finished',
    });
    expect(buildScannableTranscript(normalized)).toContain(
      'npx tsx src/cli/main.ts run --json --session demo',
    );
    expect(buildScannableTranscript(normalized)).not.toContain(
      'command finished',
    );
    expect(countAgentTtyCalls(normalized)).toBe(1);
  });

  it('normalizes complete JSON usage objects and prefers the last valid record', () => {
    const provider = new CodexProvider();
    const raw = toJsonLines([
      {
        type: 'response.created',
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          total_tokens: 25,
          input_tokens_details: {
            cached_tokens: 4,
          },
          ignored: 'field',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'done',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 30,
          output_tokens: 9,
          total_tokens: 39,
          cached_input_tokens: 12,
        },
      },
    ]);

    const normalized = provider.parse(raw);

    expect(normalized.finalText).toBe('done');
    expect(normalized.tokenUsage).toStrictEqual({
      inputTokens: 30,
      outputTokens: 9,
      totalTokens: 39,
      cachedTokens: 12,
    });
  });

  it.each([
    {
      name: 'missing total_tokens',
      records: [
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 30,
            output_tokens: 9,
            cached_input_tokens: 12,
          },
        },
      ],
    },
    {
      name: 'conflicting cached-token aliases',
      records: [
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 30,
            output_tokens: 9,
            total_tokens: 39,
            cached_input_tokens: 12,
            input_tokens_details: {
              cached_tokens: 13,
            },
          },
        },
      ],
    },
  ])('omits tokenUsage for $name', ({ records }) => {
    const provider = new CodexProvider();
    const raw = toJsonLines(records);

    const normalized = provider.parse(raw);

    expect(normalized.tokenUsage).toBeUndefined();
  });

  it('does not emit tokenUsage for plain-text output', () => {
    const provider = new CodexProvider();

    const normalized = provider.parse('done');

    expect(normalized.tokenUsage).toBeUndefined();
  });
});
