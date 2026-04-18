import { assertString, invariant } from '../../src/util/assert.js';

import type { SchedulerItemSettlement } from '../lib/scheduler.js';
import type { EvalLane, EvalWorkItemIdentity } from '../lib/types.js';
import type { ReporterEventPayloads } from './types.js';

type CaseProgressEventName = 'caseStart' | 'caseFinish';

export type CaseProgressIdentity = Pick<
  EvalWorkItemIdentity,
  'caseId' | 'condition'
>;

export type CaseProgressResult = {
  ok: boolean;
};

export interface PlannedCase {
  caseId: string;
  condition: EvalWorkItemIdentity['condition'];
  plannedTrials: number;
}

export interface CaseProgressDispatcher {
  dispatch<K extends CaseProgressEventName>(
    eventName: K,
    payload: ReporterEventPayloads[K],
  ): Promise<void> | void;
}

export interface CaseProgressTrackerOptions<
  TItem extends CaseProgressIdentity,
  TResult extends CaseProgressResult,
> {
  runId: string;
  lane: EvalLane;
  plannedCases: ReadonlyMap<string, PlannedCase>;
  dispatcher?: CaseProgressDispatcher;
  now?: () => string;
  getScore?: (item: TItem, result: TResult) => number | null;
}

interface CaseProgressState {
  plannedCase: PlannedCase;
  startedAt: string | null;
  startedAtMs: number | null;
  completedTrials: number;
  passed: number;
  failed: number;
  errored: number;
  scoreSum: number;
  scoreCount: number;
  finished: boolean;
}

function buildCaseProgressKey(identity: CaseProgressIdentity): string {
  return `${identity.caseId}\u0000${identity.condition}`;
}

function validateCaseIdentity(
  identity: CaseProgressIdentity,
  label: string,
): void {
  assertString(identity.caseId, `${label}.caseId must be a string`);
  invariant(identity.caseId.length > 0, `${label}.caseId must not be empty`);
  assertString(identity.condition, `${label}.condition must be a string`);
  invariant(
    identity.condition.length > 0,
    `${label}.condition must not be empty`,
  );
}

function parseTimestampMs(value: string, label: string): number {
  assertString(value, `${label} must be a string`);
  invariant(value.length > 0, `${label} must not be empty`);

  const timestampMs = Date.parse(value);
  invariant(Number.isFinite(timestampMs), `${label} must be a valid ISO timestamp`);
  return timestampMs;
}

function defaultScoreFromResult(result: CaseProgressResult): number | null {
  const scoreValue = (result as { score?: unknown }).score;
  if (scoreValue === undefined || scoreValue === null) {
    return null;
  }
  if (typeof scoreValue === 'number') {
    invariant(Number.isFinite(scoreValue), 'fulfilled score must be a finite number');
    return scoreValue;
  }
  if (typeof scoreValue === 'object') {
    const totalValue = (scoreValue as { total?: unknown }).total;
    if (totalValue === undefined || totalValue === null) {
      return null;
    }
    invariant(
      typeof totalValue === 'number' && Number.isFinite(totalValue),
      'fulfilled score.total must be a finite number',
    );
    return totalValue;
  }

  invariant(
    false,
    'fulfilled score must be null, a finite number, or an object with numeric total',
  );
}

function createCaseLabel(plannedCase: PlannedCase): string {
  return `${plannedCase.caseId} (${plannedCase.condition})`;
}

function createCaseState(plannedCase: PlannedCase): CaseProgressState {
  return {
    plannedCase: {
      caseId: plannedCase.caseId,
      condition: plannedCase.condition,
      plannedTrials: plannedCase.plannedTrials,
    },
    startedAt: null,
    startedAtMs: null,
    completedTrials: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    scoreSum: 0,
    scoreCount: 0,
    finished: false,
  };
}

export function computePlannedCases(
  items: readonly CaseProgressIdentity[],
): Map<string, PlannedCase> {
  const plannedCases = new Map<string, PlannedCase>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    invariant(
      item !== undefined,
      `Missing work item at index ${String(index)}`,
    );
    validateCaseIdentity(item, `items[${String(index)}]`);

    const key = buildCaseProgressKey(item);
    const existing = plannedCases.get(key);
    if (existing === undefined) {
      plannedCases.set(key, {
        caseId: item.caseId,
        condition: item.condition,
        plannedTrials: 1,
      });
      continue;
    }

    existing.plannedTrials += 1;
  }

  return plannedCases;
}

export class CaseProgressTracker<
  TItem extends CaseProgressIdentity,
  TResult extends CaseProgressResult,
> {
  private readonly runId: string;
  private readonly lane: EvalLane;
  private readonly dispatcher: CaseProgressDispatcher | undefined;
  private readonly now: () => string;
  private readonly getScore: (item: TItem, result: TResult) => number | null;
  private readonly caseStates: Map<string, CaseProgressState>;

  public constructor(options: CaseProgressTrackerOptions<TItem, TResult>) {
    assertString(options.runId, 'tracker runId must be a string');
    invariant(options.runId.length > 0, 'tracker runId must not be empty');
    assertString(options.lane, 'tracker lane must be a string');
    invariant(options.lane.length > 0, 'tracker lane must not be empty');
    invariant(
      options.dispatcher === undefined || typeof options.dispatcher.dispatch === 'function',
      'tracker dispatcher must expose a dispatch function or be undefined',
    );
    invariant(
      options.now === undefined || typeof options.now === 'function',
      'tracker now must be a function or undefined',
    );
    invariant(
      options.getScore === undefined || typeof options.getScore === 'function',
      'tracker getScore must be a function or undefined',
    );

    this.runId = options.runId;
    this.lane = options.lane;
    this.dispatcher = options.dispatcher;
    this.now = options.now ?? (() => new Date().toISOString());
    this.getScore =
      options.getScore ?? ((_item, result) => defaultScoreFromResult(result));
    this.caseStates = new Map<string, CaseProgressState>();

    for (const [key, plannedCase] of options.plannedCases.entries()) {
      validateCaseIdentity(plannedCase, `plannedCases[${key}]`);
      invariant(
        Number.isInteger(plannedCase.plannedTrials) && plannedCase.plannedTrials > 0,
        `plannedCases[${key}].plannedTrials must be a positive integer`,
      );
      invariant(
        key === buildCaseProgressKey(plannedCase),
        `plannedCases key mismatch for ${createCaseLabel(plannedCase)}`,
      );
      this.caseStates.set(key, createCaseState(plannedCase));
    }
  }

  public async onTrialStart(item: TItem): Promise<void> {
    const state = this.getState(item);
    invariant(
      !state.finished,
      `Received trial start after case finish for ${createCaseLabel(state.plannedCase)}`,
    );
    if (state.startedAt !== null) {
      return;
    }

    const startedAt = this.getTimestamp('tracker startedAt');
    state.startedAt = startedAt.iso;
    state.startedAtMs = startedAt.ms;

    await this.dispatcher?.dispatch('caseStart', {
      runId: this.runId,
      lane: this.lane,
      caseId: state.plannedCase.caseId,
      condition: state.plannedCase.condition,
      plannedTrials: state.plannedCase.plannedTrials,
      startedAt: startedAt.iso,
    });
  }

  public async onTrialFinish(
    item: TItem,
    settled: SchedulerItemSettlement<TResult>,
  ): Promise<void> {
    const state = this.getState(item);
    invariant(
      state.startedAt !== null && state.startedAtMs !== null,
      `Received trial finish before case start for ${createCaseLabel(state.plannedCase)}`,
    );
    invariant(
      !state.finished,
      `Received trial finish after case finish for ${createCaseLabel(state.plannedCase)}`,
    );

    if (settled.status === 'fulfilled') {
      if (settled.value.ok) {
        state.passed += 1;
      } else {
        state.failed += 1;
      }

      const score = this.getScore(item, settled.value);
      if (score !== null) {
        invariant(
          Number.isFinite(score),
          'tracker getScore must return a finite number or null',
        );
        state.scoreSum += score;
        state.scoreCount += 1;
      }
    } else {
      state.errored += 1;
    }

    state.completedTrials += 1;
    invariant(
      state.completedTrials <= state.plannedCase.plannedTrials,
      `Completed trials exceeded planned trials for ${createCaseLabel(state.plannedCase)}`,
    );
    if (state.completedTrials !== state.plannedCase.plannedTrials) {
      return;
    }

    const completedAt = this.getTimestamp('tracker completedAt');
    invariant(
      completedAt.ms >= state.startedAtMs,
      `Completed timestamp must not be earlier than started timestamp for ${createCaseLabel(state.plannedCase)}`,
    );
    state.finished = true;

    await this.dispatcher?.dispatch('caseFinish', {
      runId: this.runId,
      lane: this.lane,
      caseId: state.plannedCase.caseId,
      condition: state.plannedCase.condition,
      startedAt: state.startedAt,
      completedAt: completedAt.iso,
      durationMs: completedAt.ms - state.startedAtMs,
      passed: state.passed,
      failed: state.failed,
      errored: state.errored,
      meanScore:
        state.scoreCount === 0 ? null : state.scoreSum / state.scoreCount,
      artifactPath: null,
      reportPath: null,
    });
  }

  private getState(item: TItem): CaseProgressState {
    validateCaseIdentity(item, 'trial item');

    const key = buildCaseProgressKey(item);
    const state = this.caseStates.get(key);
    invariant(
      state !== undefined,
      `Unknown planned case for ${item.caseId} (${item.condition})`,
    );
    return state;
  }

  private getTimestamp(label: string): { iso: string; ms: number } {
    const iso = this.now();
    return {
      iso,
      ms: parseTimestampMs(iso, label),
    };
  }
}
