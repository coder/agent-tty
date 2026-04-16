import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JsonReport, PerCaseComparison } from '../../evals/lib/types.js';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

interface EvalRunSummary {
  ok: boolean;
  providerId: string;
  lanes: string[];
  conditions: string[];
  totalResults: number;
  jsonReportPath: string;
  markdownReportPath: string;
}

function runEvalCli(argumentsList: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './evals/run.ts', ...argumentsList],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: DEFAULT_EVAL_TIMEOUT_MS,
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return result;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function expectPerCaseComparisonShape(comparison: PerCaseComparison): void {
  expect(comparison).toEqual(
    expect.objectContaining({
      caseId: expect.any(String),
      condition: expect.any(String),
      baselinePassRate: expect.any(Number),
      candidatePassRate: expect.any(Number),
      baselineMeanScore: expect.any(Number),
      candidateMeanScore: expect.any(Number),
      scoreDelta: expect.objectContaining({
        mean: expect.any(Number),
        ci: expect.objectContaining({
          lower: expect.any(Number),
          upper: expect.any(Number),
        }),
        significant: expect.any(Boolean),
      }),
      passRateDelta: expect.objectContaining({
        mean: expect.any(Number),
        ci: expect.objectContaining({
          lower: expect.any(Number),
          upper: expect.any(Number),
        }),
        significant: expect.any(Boolean),
      }),
      winRate: expect.objectContaining({
        wins: expect.any(Number),
        losses: expect.any(Number),
        ties: expect.any(Number),
        n: expect.any(Number),
        winRate: expect.any(Number),
      }),
      verdict: expect.any(String),
    }),
  );
}

let testRoot = '';

describe(
  'eval CLI compare-baseline reporting',
  {
    timeout: DEFAULT_EVAL_TIMEOUT_MS,
  },
  () => {
    beforeEach(() => {
      // prettier-ignore
      testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-evals-compare-baseline-')));
    });

    afterEach(() => {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    });

    it('shows --compare-baseline in the help output', () => {
      const result = runEvalCli(['--help']);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--compare-baseline <path>');
    });

    it('adds paired baseline comparison data to JSON and Markdown reports', () => {
      const baselineOutputDir = join(testRoot, 'baseline');
      const candidateOutputDir = join(testRoot, 'candidate');
      const sharedArguments = [
        '--provider',
        'stub',
        '--lane',
        'prompt',
        '--condition',
        'none',
        '--trials',
        '3',
        '--json',
      ] as const;

      const baselineResult = runEvalCli([
        ...sharedArguments,
        '--output',
        baselineOutputDir,
      ]);
      const baselineSummary = JSON.parse(
        baselineResult.stdout,
      ) as EvalRunSummary;
      expect(baselineResult.status).toBe(baselineSummary.ok ? 0 : 1);
      expect(baselineSummary).toMatchObject({
        providerId: 'stub',
        lanes: ['prompt'],
        conditions: ['none'],
      });

      const baselineReport = readJsonFile<JsonReport>(
        baselineSummary.jsonReportPath,
      );

      const candidateResult = runEvalCli([
        ...sharedArguments,
        '--output',
        candidateOutputDir,
        '--compare-baseline',
        baselineSummary.jsonReportPath,
      ]);
      const candidateSummary = JSON.parse(
        candidateResult.stdout,
      ) as EvalRunSummary;
      expect(candidateResult.status).toBe(candidateSummary.ok ? 0 : 1);
      expect(candidateSummary).toMatchObject({
        providerId: 'stub',
        lanes: ['prompt'],
        conditions: ['none'],
      });

      const candidateReport = readJsonFile<JsonReport>(
        candidateSummary.jsonReportPath,
      );
      const candidateMarkdown = readFileSync(
        candidateSummary.markdownReportPath,
        'utf8',
      );
      const baselineComparison = candidateReport.baselineComparison;

      expect(baselineComparison).toBeDefined();
      if (baselineComparison === undefined) {
        throw new Error(
          'Expected baseline comparison data in candidate report',
        );
      }

      expect(baselineComparison.baselineRunId).toBe(
        baselineReport.metadata.runId,
      );
      expect(baselineComparison.baselineCreatedAt).toBe(
        baselineReport.metadata.createdAt,
      );
      expect(baselineComparison.perCase.length).toBeGreaterThan(0);
      for (const perCase of baselineComparison.perCase) {
        expectPerCaseComparisonShape(perCase);
        expect(perCase.verdict).toBe('inconclusive');
      }

      expect(baselineComparison.overall.verdict).toBe('inconclusive');
      expect(candidateMarkdown).toContain('## Trial Aggregation');
      expect(candidateMarkdown).toContain('## Baseline comparison');
      expect(candidateMarkdown.indexOf('## Trial Aggregation')).toBeLessThan(
        candidateMarkdown.indexOf('## Baseline comparison'),
      );
      expect(candidateMarkdown.indexOf('## Baseline comparison')).toBeLessThan(
        candidateMarkdown.indexOf('## Anti-pattern summary'),
      );
    });
  },
);
