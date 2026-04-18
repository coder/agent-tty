import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReporterDispatcher,
  redactSecretLikeValues,
} from '../../../../evals/reporters/dispatch.js';
import type { TokenReportSummary } from '../../../../evals/lib/types.js';
import type {
  RunFinishEvent,
  RunStartEvent,
} from '../../../../evals/reporters/types.js';

function createRunStartEvent(
  overrides: Partial<RunStartEvent> = {},
): RunStartEvent {
  return {
    runId: 'run-123',
    provider: 'stub',
    model: 'stub-model',
    lanes: ['prompt', 'execution'],
    conditions: ['none', 'self-load'],
    totalTrials: 2,
    totalInvocations: 8,
    outputDir: '/tmp/evals/run-123',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createRunFinishEvent(
  overrides: Partial<RunFinishEvent> = {},
): RunFinishEvent {
  return {
    runId: 'run-123',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:05.000Z',
    durationMs: 5000,
    total: 8,
    passed: 6,
    failed: 1,
    errored: 1,
    laneErrors: [],
    runDir: '/tmp/evals/run-123',
    reportJsonPath: '/tmp/evals/run-123/report.json',
    reportMarkdownPath: '/tmp/evals/run-123/report.md',
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTokenReportSummary(): TokenReportSummary {
  return {
    grandTotal: {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cachedTokens: 4,
      trials: 1,
    },
    perLane: [
      {
        lane: 'prompt',
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedTokens: 4,
        trials: 1,
      },
    ],
    perCase: [
      {
        lane: 'prompt',
        caseId: 'case-1',
        condition: 'none',
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedTokens: 4,
        trials: 1,
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReporterDispatcher', () => {
  it('preserves reporter order across multi-reporter fan-out', async () => {
    const seen: string[] = [];
    const dispatcher = new ReporterDispatcher([
      {
        name: 'first',
        onRunStart: () => {
          seen.push('first:runStart');
        },
        onRunFinish: () => {
          seen.push('first:runFinish');
        },
      },
      {
        name: 'second',
        onRunStart: () => {
          seen.push('second:runStart');
        },
        onRunFinish: () => {
          seen.push('second:runFinish');
        },
      },
      {
        name: 'third',
        onRunStart: () => {
          seen.push('third:runStart');
        },
        onRunFinish: () => {
          seen.push('third:runFinish');
        },
      },
    ]);

    await dispatcher.dispatch('runStart', createRunStartEvent());
    await dispatcher.dispatch('runFinish', createRunFinishEvent());

    expect(seen).toEqual([
      'first:runStart',
      'second:runStart',
      'third:runStart',
      'first:runFinish',
      'second:runFinish',
      'third:runFinish',
    ]);
  });

  it('isolates reporter failures and logs them to stderr', async () => {
    const seen: string[] = [];
    const stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true);
    const dispatcher = new ReporterDispatcher([
      {
        name: 'first',
        onRunStart: () => {
          seen.push('first');
        },
      },
      {
        name: 'broken',
        onRunStart: () => {
          throw new Error('boom');
        },
      },
      {
        name: 'third',
        onRunStart: () => {
          seen.push('third');
        },
      },
    ]);

    await dispatcher.dispatch('runStart', createRunStartEvent());

    expect(seen).toEqual(['first', 'third']);
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'reporter "broken" failed on runStart: boom\n',
    );
  });

  it('throws descriptive validation errors for missing required fields and wrong types', async () => {
    const dispatcher = new ReporterDispatcher();
    const missingProvider = {
      ...createRunStartEvent(),
    } as Partial<RunStartEvent>;
    delete missingProvider.provider;

    await expect(
      dispatcher.dispatch(
        'runStart',
        missingProvider as unknown as RunStartEvent,
      ),
    ).rejects.toThrow(
      /Invalid reporter payload for event "runStart": provider:/,
    );

    await expect(
      dispatcher.dispatch('runStart', {
        ...createRunStartEvent(),
        totalTrials: 'two',
      } as unknown as RunStartEvent),
    ).rejects.toThrow(
      /Invalid reporter payload for event "runStart": totalTrials:/,
    );
  });

  it('validates runFinish payloads with and without tokenReport', async () => {
    const onRunFinish = vi.fn();
    const dispatcher = new ReporterDispatcher([
      {
        name: 'capture',
        onRunFinish,
      },
    ]);
    const bareRunFinish = createRunFinishEvent();
    const tokenizedRunFinish = createRunFinishEvent({
      tokenReport: createTokenReportSummary(),
    });

    await expect(dispatcher.dispatch('runFinish', bareRunFinish)).resolves.toBeUndefined();
    await expect(
      dispatcher.dispatch('runFinish', tokenizedRunFinish),
    ).resolves.toBeUndefined();

    expect(onRunFinish).toHaveBeenNthCalledWith(1, bareRunFinish);
    expect(onRunFinish).toHaveBeenNthCalledWith(2, tokenizedRunFinish);
  });

  it('rejects malformed nested tokenReport payloads on runFinish', async () => {
    const dispatcher = new ReporterDispatcher();
    const tokenReport = createTokenReportSummary();

    await expect(
      dispatcher.dispatch('runFinish', {
        ...createRunFinishEvent(),
        tokenReport: {
          ...tokenReport,
          perLane: [
            {
              ...tokenReport.perLane[0],
              unexpected: 1,
            },
          ],
        },
      } as unknown as RunFinishEvent),
    ).rejects.toThrow(/tokenReport\.perLane\.0: Unrecognized key/);

    await expect(
      dispatcher.dispatch('runFinish', {
        ...createRunFinishEvent(),
        tokenReport: {
          ...tokenReport,
          grandTotal: {
            ...tokenReport.grandTotal,
            totalTokens: 20.5,
          },
        },
      } as unknown as RunFinishEvent),
    ).rejects.toThrow(/tokenReport\.grandTotal\.totalTokens:/);
  });

  it('rejects duplicate reporter names at construction', () => {
    expect(
      () =>
        new ReporterDispatcher([{ name: 'duplicate' }, { name: 'duplicate' }]),
    ).toThrow('Duplicate reporter name: duplicate');
  });

  it('awaits async reporters sequentially in reporter order', async () => {
    const events: string[] = [];
    const dispatcher = new ReporterDispatcher([
      {
        name: 'slow',
        onRunStart: async () => {
          events.push('slow:start');
          await delay(25);
          events.push('slow:end');
        },
      },
      {
        name: 'fast',
        onRunStart: async () => {
          events.push('fast:start');
          await delay(5);
          events.push('fast:end');
        },
      },
    ]);

    await dispatcher.dispatch('runStart', createRunStartEvent());

    expect(events).toEqual([
      'slow:start',
      'slow:end',
      'fast:start',
      'fast:end',
    ]);
  });
});

describe('redactSecretLikeValues', () => {
  it('redacts secret-like keys recursively while preserving ordinary keys', () => {
    const input = {
      FOO_TOKEN: 'abc123',
      BAR_KEY: 42,
      ordinary: 'keep-me',
      creds: {
        SESSION_SECRET: 'shh',
        nestedValue: 'keep-nested',
      },
      items: [
        {
          PASSWORD: 'hunter2',
          label: 'first',
        },
        {
          label: 'second',
        },
      ],
    };

    const redacted = redactSecretLikeValues(input);

    expect(redacted).toEqual({
      FOO_TOKEN: '[REDACTED]',
      BAR_KEY: '[REDACTED]',
      ordinary: 'keep-me',
      creds: {
        SESSION_SECRET: '[REDACTED]',
        nestedValue: 'keep-nested',
      },
      items: [
        {
          PASSWORD: '[REDACTED]',
          label: 'first',
        },
        {
          label: 'second',
        },
      ],
    });
    expect(input).toEqual({
      FOO_TOKEN: 'abc123',
      BAR_KEY: 42,
      ordinary: 'keep-me',
      creds: {
        SESSION_SECRET: 'shh',
        nestedValue: 'keep-nested',
      },
      items: [
        {
          PASSWORD: 'hunter2',
          label: 'first',
        },
        {
          label: 'second',
        },
      ],
    });
  });
});
