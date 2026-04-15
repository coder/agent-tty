import { describe, expect, it } from 'vitest';

import {
  buildScannableTranscript,
  countAgentTtyCalls,
} from '../../../evals/lib/antiPatterns.js';
import { CodexProvider } from '../../../evals/providers/codex.js';

describe('CodexProvider.parse', () => {
  it('normalizes command_execution items into shell-style tool calls', () => {
    const provider = new CodexProvider();
    const raw = [
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
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');

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
    expect(buildScannableTranscript(normalized)).toContain('snapshot ready');
    expect(countAgentTtyCalls(normalized)).toBe(1);
  });

  it('normalizes function_call records with parsed arguments and outputs', () => {
    const provider = new CodexProvider();
    const raw = [
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
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');

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
    expect(buildScannableTranscript(normalized)).toContain('command finished');
    expect(countAgentTtyCalls(normalized)).toBe(1);
  });
});
