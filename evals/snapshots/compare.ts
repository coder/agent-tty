import { invariant } from '../../src/util/assert.js';
import { SnapshotEntrySchema } from './schema.js';
import type { SnapshotEntry } from './schema.js';

export interface SnapshotComparableRecord
  extends Pick<
    SnapshotEntry,
    | 'provider'
    | 'model'
    | 'lane'
    | 'caseId'
    | 'condition'
    | 'caseFingerprint'
    | 'totalTokens'
  > {}

export type SnapshotCheckOutcome =
  | 'new'
  | 'orphaned'
  | 'unchanged'
  | 'improved'
  | 'regressed';

export interface SnapshotCheckCase extends SnapshotComparableRecord {
  outcome: SnapshotCheckOutcome;
  currentTotalTokens?: number;
  snapshotTotalTokens?: number;
  deltaTokens?: number;
  deltaPercent?: number;
}

export interface SnapshotCheckSummary {
  total: number;
  new: number;
  orphaned: number;
  unchanged: number;
  improved: number;
  regressed: number;
}

export interface SnapshotCheckReport {
  regressionThresholdPercent: number;
  cases: SnapshotCheckCase[];
  summary: SnapshotCheckSummary;
}

export interface CompareSnapshotRecordsOptions {
  currentRecords: readonly SnapshotComparableRecord[];
  snapshotRecords: readonly SnapshotComparableRecord[];
  regressionThresholdPercent: number;
}

const SnapshotComparableRecordSchema = SnapshotEntrySchema.pick({
  provider: true,
  model: true,
  lane: true,
  caseId: true,
  condition: true,
  caseFingerprint: true,
  totalTokens: true,
});

function buildSnapshotComparisonKey(record: SnapshotComparableRecord): string {
  return JSON.stringify([
    record.provider,
    record.model,
    record.lane,
    record.caseId,
    record.condition,
    record.caseFingerprint,
  ]);
}

function createRecordMap(
  records: readonly SnapshotComparableRecord[],
  label: string,
): Map<string, SnapshotComparableRecord> {
  const recordMap = new Map<string, SnapshotComparableRecord>();

  for (const record of records) {
    const parsedRecord = SnapshotComparableRecordSchema.safeParse(record);
    if (!parsedRecord.success) {
      invariant(false, `${label} validation failed: ${parsedRecord.error.message}`);
    }

    const key = buildSnapshotComparisonKey(parsedRecord.data);
    invariant(!recordMap.has(key), `Duplicate ${label} key: ${key}`);
    recordMap.set(key, parsedRecord.data);
  }

  return recordMap;
}

function classifySnapshotCase(
  currentRecord: SnapshotComparableRecord | undefined,
  snapshotRecord: SnapshotComparableRecord | undefined,
  regressionThresholdPercent: number,
): SnapshotCheckCase {
  const sourceRecord = currentRecord ?? snapshotRecord;
  invariant(sourceRecord !== undefined, 'Snapshot comparison source record must exist');

  if (currentRecord === undefined) {
    invariant(
      snapshotRecord !== undefined,
      'orphaned snapshot comparisons must include a stored record',
    );
    return {
      ...sourceRecord,
      outcome: 'orphaned',
      snapshotTotalTokens: snapshotRecord.totalTokens,
    };
  }

  if (snapshotRecord === undefined) {
    invariant(
      currentRecord !== undefined,
      'new snapshot comparisons must include a current record',
    );
    return {
      ...sourceRecord,
      outcome: 'new',
      currentTotalTokens: currentRecord.totalTokens,
    };
  }

  const currentTotalTokens = currentRecord.totalTokens;
  const snapshotTotalTokens = snapshotRecord.totalTokens;
  const deltaTokens = currentTotalTokens - snapshotTotalTokens;
  const deltaPercent =
    snapshotTotalTokens > 0
      ? (deltaTokens / snapshotTotalTokens) * 100
      : undefined;

  if (currentTotalTokens < snapshotTotalTokens) {
    return {
      ...sourceRecord,
      outcome: 'improved',
      currentTotalTokens,
      snapshotTotalTokens,
      deltaTokens,
      ...(deltaPercent === undefined ? {} : { deltaPercent }),
    };
  }

  const regressionCeiling =
    snapshotTotalTokens * (1 + regressionThresholdPercent / 100);
  if (currentTotalTokens > regressionCeiling) {
    return {
      ...sourceRecord,
      outcome: 'regressed',
      currentTotalTokens,
      snapshotTotalTokens,
      deltaTokens,
      ...(deltaPercent === undefined ? {} : { deltaPercent }),
    };
  }

  return {
    ...sourceRecord,
    outcome: 'unchanged',
    currentTotalTokens,
    snapshotTotalTokens,
    deltaTokens,
    ...(deltaPercent === undefined ? {} : { deltaPercent }),
  };
}

export function compareSnapshotRecords(
  options: CompareSnapshotRecordsOptions,
): SnapshotCheckReport {
  invariant(
    Number.isFinite(options.regressionThresholdPercent) &&
      options.regressionThresholdPercent >= 0,
    'regressionThresholdPercent must be a finite non-negative number',
  );

  const currentRecordMap = createRecordMap(
    options.currentRecords,
    'current snapshot record',
  );
  const snapshotRecordMap = createRecordMap(
    options.snapshotRecords,
    'stored snapshot record',
  );

  const comparisonKeys = Array.from(
    new Set([...currentRecordMap.keys(), ...snapshotRecordMap.keys()]),
  ).sort((left, right) => left.localeCompare(right));
  const cases = comparisonKeys.map((key) =>
    classifySnapshotCase(
      currentRecordMap.get(key),
      snapshotRecordMap.get(key),
      options.regressionThresholdPercent,
    ),
  );

  const summary = cases.reduce<SnapshotCheckSummary>(
    (result, entry) => ({
      ...result,
      total: result.total + 1,
      [entry.outcome]: result[entry.outcome] + 1,
    }),
    {
      total: 0,
      new: 0,
      orphaned: 0,
      unchanged: 0,
      improved: 0,
      regressed: 0,
    },
  );

  return {
    regressionThresholdPercent: options.regressionThresholdPercent,
    cases,
    summary,
  };
}
