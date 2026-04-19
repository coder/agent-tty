import { invariant } from '../../src/util/assert.js';

import type {
  CaseFinishEvent,
  CaseStartEvent,
  LaneFinishEvent,
  LaneStartEvent,
  Reporter,
  RunFinishEvent,
  RunStartEvent,
  TrialFinishEvent,
  TrialStartEvent,
} from './types.js';

export interface ConsoleReporterOptions {
  verbose?: boolean;
  writeLine?: (line: string) => void;
}

function defaultWriteLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

function formatNullableNumber(value: number | null): string {
  return value === null ? '-' : String(value);
}

function formatModel(value: string): string {
  return value.length === 0 ? '-' : value;
}

export class ConsoleReporter implements Reporter {
  public readonly name = 'console';

  private readonly verbose: boolean;
  private readonly writeLine: (line: string) => void;

  public constructor(options: ConsoleReporterOptions = {}) {
    const { verbose = false, writeLine = defaultWriteLine } = options;

    invariant(
      typeof verbose === 'boolean',
      'console reporter verbose must be a boolean',
    );
    invariant(
      typeof writeLine === 'function',
      'console reporter writeLine must be a function',
    );

    this.verbose = verbose;
    this.writeLine = writeLine;
  }

  public onRunStart(event: RunStartEvent): void {
    this.writeLine(
      `run ${event.runId} started: provider=${event.provider} model=${formatModel(event.model)} lanes=${event.lanes.join(',')} conditions=${event.conditions.join(',')} trials=${String(event.totalTrials)} invocations=${String(event.totalInvocations)}`,
    );
  }

  public onLaneStart(event: LaneStartEvent): void {
    this.writeLine(
      `lane ${event.lane} started: cases=${String(event.caseIds.length)} conditions=${String(event.conditions.length)} concurrency=${String(event.concurrency)} planned=${String(event.plannedItems)}`,
    );
  }

  public onCaseStart(event: CaseStartEvent): void {
    this.writeLine(
      `case ${event.lane}/${event.caseId} [${event.condition}] started: trials=${String(event.plannedTrials)}`,
    );
  }

  public onTrialStart(event: TrialStartEvent): void {
    if (!this.verbose) {
      return;
    }

    this.writeLine(
      `trial ${event.lane}/${event.caseId}[${event.condition}]#${String(event.trial)} started`,
    );
  }

  public onTrialFinish(event: TrialFinishEvent): void {
    if (!this.verbose) {
      return;
    }

    this.writeLine(
      `trial ${event.lane}/${event.caseId}[${event.condition}]#${String(event.trial)} ${event.status} ok=${String(event.ok)} durationMs=${String(event.durationMs)} score=${formatNullableNumber(event.score)}`,
    );
  }

  public onCaseFinish(event: CaseFinishEvent): void {
    this.writeLine(
      `case ${event.lane}/${event.caseId} [${event.condition}] finished: passed=${String(event.passed)} failed=${String(event.failed)} errored=${String(event.errored)} meanScore=${formatNullableNumber(event.meanScore)} durationMs=${String(event.durationMs)}`,
    );
  }

  public onLaneFinish(event: LaneFinishEvent): void {
    this.writeLine(
      `lane ${event.lane} finished: total=${String(event.total)} passed=${String(event.passed)} failed=${String(event.failed)} errored=${String(event.errored)} durationMs=${String(event.durationMs)}`,
    );
  }

  public onRunFinish(event: RunFinishEvent): void {
    this.writeLine(
      `run ${event.runId} finished: total=${String(event.total)} passed=${String(event.passed)} failed=${String(event.failed)} errored=${String(event.errored)} durationMs=${String(event.durationMs)}`,
    );
  }
}
