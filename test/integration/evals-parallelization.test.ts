import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const TIMING_KEYS = new Set([
  'runId',
  'createdAt',
  'startedAt',
  'completedAt',
  'durationMs',
  'detectedAt',
]);
const PATH_KEYS = new Set([
  'repoRoot',
  'cwd',
  'homeDir',
  'outputDir',
  'commandPath',
]);
const VARIABLE_NOTE_PREFIXES = [
  'output base dir: ',
  'provider command path: ',
] as const;

type TestedLane = 'prompt' | 'execution';

interface EvalRunSummary {
  ok: boolean;
  providerId: string;
  lanes: string[];
  conditions: string[];
  totalResults: number;
  jsonReportPath: string;
}

interface EvalRunOutput {
  summary: EvalRunSummary;
  report: unknown;
}

function isVariableNote(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    VARIABLE_NOTE_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function isEphemeralKey(key: string): boolean {
  return (
    TIMING_KEYS.has(key) ||
    PATH_KEYS.has(key) ||
    key.endsWith('Path') ||
    key.endsWith('Dir')
  );
}

function normalizeEvalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeEvalValue(item))
      .filter((item) => !isVariableNote(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isEphemeralKey(key))
        .map(([key, item]) => [key, normalizeEvalValue(item)]),
    );
  }

  return value;
}

function runEvalLane(
  lane: TestedLane,
  concurrency: number,
  testRoot: string,
): EvalRunOutput {
  const outputDir = join(testRoot, `${lane}-${String(concurrency)}`);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      './evals/run.ts',
      '--provider',
      'stub',
      '--lane',
      lane,
      '--condition',
      'none',
      '--concurrency',
      String(concurrency),
      '--output',
      outputDir,
      '--json',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: DEFAULT_EVAL_TIMEOUT_MS,
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).not.toBeNull();

  const summary = JSON.parse(result.stdout) as EvalRunSummary;
  const exitCode = result.status;
  if (exitCode === null) {
    throw new Error('eval CLI exit code must not be null');
  }

  expect(exitCode).toBe(summary.ok ? 0 : 1);
  expect(summary).toMatchObject({
    providerId: 'stub',
    lanes: [lane],
    conditions: ['none'],
  });
  expect(summary.totalResults).toBeGreaterThan(0);

  const report = JSON.parse(
    readFileSync(summary.jsonReportPath, 'utf8'),
  ) as unknown;
  return { summary, report };
}

let testRoot = '';

describe('eval scheduler parity', { timeout: DEFAULT_EVAL_TIMEOUT_MS }, () => {
  beforeEach(() => {
    // prettier-ignore
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-evals-parity-')));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    testRoot = '';
  });

  for (const lane of ['prompt', 'execution'] as const) {
    it(`matches ${lane} lane results between concurrency 1 and 4`, () => {
      const serial = runEvalLane(lane, 1, testRoot);
      const parallel = runEvalLane(lane, 4, testRoot);

      expect(normalizeEvalValue(serial.summary)).toEqual(
        normalizeEvalValue(parallel.summary),
      );
      expect(normalizeEvalValue(serial.report)).toEqual(
        normalizeEvalValue(parallel.report),
      );
    });
  }
});
