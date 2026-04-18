import { assertString, invariant } from '../../src/util/assert.js';

import { SKILL_CONDITIONS } from './matrix.js';
import type {
  EvalLane,
  SkillCondition,
  TokenReportSummary,
  TokenUsage,
} from './types.js';

export interface RawTokenRecord {
  provider: string;
  model: string;
  lane: EvalLane;
  caseId: string;
  condition: SkillCondition;
  caseFingerprint: string;
  usage: TokenUsage;
}

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokensTotal: number;
  everyRecordHasCachedTokens: boolean;
  trials: number;
}

function createTokenAccumulator(): TokenAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokensTotal: 0,
    everyRecordHasCachedTokens: true,
    trials: 0,
  };
}

function accumulateTokenUsage(
  accumulator: TokenAccumulator,
  usage: TokenUsage,
): void {
  invariant(
    Number.isInteger(usage.inputTokens) && usage.inputTokens >= 0,
    'token usage inputTokens must be a non-negative integer',
  );
  invariant(
    Number.isInteger(usage.outputTokens) && usage.outputTokens >= 0,
    'token usage outputTokens must be a non-negative integer',
  );
  invariant(
    Number.isInteger(usage.totalTokens) && usage.totalTokens >= 0,
    'token usage totalTokens must be a non-negative integer',
  );
  if (usage.cachedTokens !== undefined) {
    invariant(
      Number.isInteger(usage.cachedTokens) && usage.cachedTokens >= 0,
      'token usage cachedTokens must be a non-negative integer',
    );
  }

  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
  accumulator.totalTokens += usage.totalTokens;
  accumulator.trials += 1;
  if (usage.cachedTokens === undefined) {
    accumulator.everyRecordHasCachedTokens = false;
    return;
  }
  accumulator.cachedTokensTotal += usage.cachedTokens;
}

function emitTokenAccumulator(accumulator: TokenAccumulator): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  trials: number;
} {
  return {
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    totalTokens: accumulator.totalTokens,
    ...(accumulator.everyRecordHasCachedTokens
      ? { cachedTokens: accumulator.cachedTokensTotal }
      : {}),
    trials: accumulator.trials,
  };
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareCondition(left: SkillCondition, right: SkillCondition): number {
  return SKILL_CONDITIONS.indexOf(left) - SKILL_CONDITIONS.indexOf(right);
}

export function aggregateTokenRecords(
  records: RawTokenRecord[],
  laneOrder: string[],
): TokenReportSummary | undefined {
  invariant(Array.isArray(records), 'token records must be an array');
  invariant(Array.isArray(laneOrder), 'laneOrder must be an array');
  if (records.length === 0) {
    return undefined;
  }

  const laneIndexes = new Map<string, number>();
  for (const [index, lane] of laneOrder.entries()) {
    assertString(lane, 'laneOrder entries must be strings');
    invariant(lane.length > 0, 'laneOrder entries must not be empty');
    invariant(!laneIndexes.has(lane), `Duplicate laneOrder entry: ${lane}`);
    laneIndexes.set(lane, index);
  }

  const grandTotal = createTokenAccumulator();
  const perLaneAccumulators = new Map<string, TokenAccumulator>();
  const perCaseAccumulators = new Map<
    string,
    {
      lane: EvalLane;
      caseId: string;
      condition: SkillCondition;
      accumulator: TokenAccumulator;
    }
  >();

  for (const record of records) {
    assertString(record.caseId, 'token record caseId must be a string');
    invariant(
      record.caseId.length > 0,
      'token record caseId must not be empty',
    );
    invariant(
      laneIndexes.has(record.lane),
      `token record lane is missing from laneOrder: ${record.lane}`,
    );

    accumulateTokenUsage(grandTotal, record.usage);

    const laneAccumulator =
      perLaneAccumulators.get(record.lane) ?? createTokenAccumulator();
    accumulateTokenUsage(laneAccumulator, record.usage);
    perLaneAccumulators.set(record.lane, laneAccumulator);

    const perCaseKey = JSON.stringify([
      record.lane,
      record.caseId,
      record.condition,
    ]);
    const existingPerCase = perCaseAccumulators.get(perCaseKey);
    if (existingPerCase === undefined) {
      const accumulator = createTokenAccumulator();
      accumulateTokenUsage(accumulator, record.usage);
      perCaseAccumulators.set(perCaseKey, {
        lane: record.lane,
        caseId: record.caseId,
        condition: record.condition,
        accumulator,
      });
      continue;
    }

    accumulateTokenUsage(existingPerCase.accumulator, record.usage);
  }

  const perLane = laneOrder
    .filter((lane): lane is EvalLane => perLaneAccumulators.has(lane))
    .map((lane) => ({
      lane,
      ...emitTokenAccumulator(
        perLaneAccumulators.get(lane) ?? createTokenAccumulator(),
      ),
    }));

  const perCase = [...perCaseAccumulators.values()]
    .sort((left, right) => {
      const leftLaneIndex = laneIndexes.get(left.lane);
      const rightLaneIndex = laneIndexes.get(right.lane);
      invariant(
        leftLaneIndex !== undefined,
        `Missing laneOrder entry: ${left.lane}`,
      );
      invariant(
        rightLaneIndex !== undefined,
        `Missing laneOrder entry: ${right.lane}`,
      );
      if (leftLaneIndex !== rightLaneIndex) {
        return leftLaneIndex - rightLaneIndex;
      }
      const caseComparison = compareStrings(left.caseId, right.caseId);
      if (caseComparison !== 0) {
        return caseComparison;
      }
      return compareCondition(left.condition, right.condition);
    })
    .map((entry) => ({
      lane: entry.lane,
      caseId: entry.caseId,
      condition: entry.condition,
      ...emitTokenAccumulator(entry.accumulator),
    }));

  return {
    grandTotal: emitTokenAccumulator(grandTotal),
    perLane,
    perCase,
  };
}
