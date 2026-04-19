import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';

import { assertString, invariant } from '../../src/util/assert.js';

import type {
  CaseFinishEvent,
  CaseStartEvent,
  LaneFinishEvent,
  LaneStartEvent,
  Reporter,
  ReporterEventName,
  ReporterEventPayloads,
  RunFinishEvent,
  RunStartEvent,
  TrialFinishEvent,
  TrialStartEvent,
} from './types.js';

export interface JsonlReporterOptions {
  outputPath: string;
}

type JsonlEventType =
  | 'run.start'
  | 'lane.start'
  | 'case.start'
  | 'trial.start'
  | 'trial.finish'
  | 'case.finish'
  | 'lane.finish'
  | 'run.finish';

type ReporterEventPayload = ReporterEventPayloads[ReporterEventName];

export class JsonlReporter implements Reporter {
  public readonly name = 'jsonl';

  private readonly outputPath: string;
  private directoryReady = false;

  public constructor(options: JsonlReporterOptions) {
    assertString(
      options.outputPath,
      'jsonl reporter outputPath must be a string',
    );
    invariant(
      options.outputPath.trim().length > 0,
      'jsonl reporter outputPath must not be empty',
    );

    this.outputPath = options.outputPath;
  }

  public async onRunStart(event: RunStartEvent): Promise<void> {
    await this.appendEvent('run.start', event);
  }

  public async onLaneStart(event: LaneStartEvent): Promise<void> {
    await this.appendEvent('lane.start', event);
  }

  public async onCaseStart(event: CaseStartEvent): Promise<void> {
    await this.appendEvent('case.start', event);
  }

  public async onTrialStart(event: TrialStartEvent): Promise<void> {
    await this.appendEvent('trial.start', event);
  }

  public async onTrialFinish(event: TrialFinishEvent): Promise<void> {
    await this.appendEvent('trial.finish', event);
  }

  public async onCaseFinish(event: CaseFinishEvent): Promise<void> {
    await this.appendEvent('case.finish', event);
  }

  public async onLaneFinish(event: LaneFinishEvent): Promise<void> {
    await this.appendEvent('lane.finish', event);
  }

  public async onRunFinish(event: RunFinishEvent): Promise<void> {
    await this.appendEvent('run.finish', event);
  }

  private async appendEvent(
    type: JsonlEventType,
    payload: ReporterEventPayload,
  ): Promise<void> {
    await this.ensureDirectory();

    const line = JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
    await fs.appendFile(this.outputPath, `${line}\n`, 'utf8');
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) {
      return;
    }

    await fs.mkdir(dirname(this.outputPath), { recursive: true });
    this.directoryReady = true;
  }
}
