import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter } from '../../../../evals/reporters/console.js';

import {
  createCaseFinishEvent,
  createCaseStartEvent,
  createLaneFinishEvent,
  createLaneStartEvent,
  createRunFinishEvent,
  createRunStartEvent,
  createTrialFinishEvent,
  createTrialStartEvent,
} from './fixtures.js';

function emitRepresentativeStream(reporter: ConsoleReporter): void {
  reporter.onRunStart(createRunStartEvent());
  reporter.onLaneStart(createLaneStartEvent());
  reporter.onCaseStart(createCaseStartEvent());
  reporter.onTrialStart(createTrialStartEvent());
  reporter.onTrialFinish(createTrialFinishEvent());
  reporter.onCaseFinish(createCaseFinishEvent());
  reporter.onLaneFinish(createLaneFinishEvent());
  reporter.onRunFinish(createRunFinishEvent());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConsoleReporter', () => {
  it('emits concise boundary lines by default and omits trial lines', () => {
    const lines: string[] = [];
    const reporter = new ConsoleReporter({
      writeLine: (line) => {
        lines.push(line);
      },
    });

    emitRepresentativeStream(reporter);

    expect(lines).toEqual([
      'run run-123 started: provider=stub model=stub-model lanes=prompt,execution conditions=none,self-load trials=2 invocations=8',
      'lane prompt started: cases=1 conditions=1 concurrency=2 planned=3',
      'case prompt/case-1 [none] started: trials=2',
      'case prompt/case-1 [none] finished: passed=1 failed=0 errored=0 meanScore=0.5 durationMs=2000',
      'lane prompt finished: total=1 passed=1 failed=0 errored=0 durationMs=3000',
      'run run-123 finished: total=1 passed=1 failed=0 errored=0 durationMs=4000',
    ]);
  });

  it('adds trial-level lines in verbose mode without dropping boundary lines', () => {
    const lines: string[] = [];
    const reporter = new ConsoleReporter({
      verbose: true,
      writeLine: (line) => {
        lines.push(line);
      },
    });

    emitRepresentativeStream(reporter);

    expect(lines).toEqual([
      'run run-123 started: provider=stub model=stub-model lanes=prompt,execution conditions=none,self-load trials=2 invocations=8',
      'lane prompt started: cases=1 conditions=1 concurrency=2 planned=3',
      'case prompt/case-1 [none] started: trials=2',
      'trial prompt/case-1[none]#1 started',
      'trial prompt/case-1[none]#1 passed ok=true durationMs=1234 score=0.5',
      'case prompt/case-1 [none] finished: passed=1 failed=0 errored=0 meanScore=0.5 durationMs=2000',
      'lane prompt finished: total=1 passed=1 failed=0 errored=0 durationMs=3000',
      'run run-123 finished: total=1 passed=1 failed=0 errored=0 durationMs=4000',
    ]);
  });

  it('writes to stderr by default when writeLine is not provided', () => {
    const stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true);
    const reporter = new ConsoleReporter();

    reporter.onRunStart(createRunStartEvent());

    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'run run-123 started: provider=stub model=stub-model lanes=prompt,execution conditions=none,self-load trials=2 invocations=8\n',
    );
  });
});
