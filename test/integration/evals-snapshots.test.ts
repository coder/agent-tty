import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { snapshotFilePath } from '../../evals/snapshots/store.js';
import type { JsonReport } from '../../evals/lib/types.js';
import type { SnapshotEntry } from '../../evals/snapshots/schema.js';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const FIXTURE_MODEL = 'fixture-model';
const PASSING_WAIT_RESPONSE =
  'Use agent-tty and run `agent-tty wait --json --pattern "Listening on port 3000"` before starting the tests so you only proceed after the server is ready.';
const BASELINE_TOKEN_USAGE = {
  inputTokens: 80,
  outputTokens: 20,
  totalTokens: 100,
  cachedTokens: 10,
} as const;
const REGRESSED_TOKEN_USAGE = {
  inputTokens: 100,
  outputTokens: 30,
  totalTokens: 130,
  cachedTokens: 15,
} as const;

type FixtureTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
};

interface EvalRunSummary {
  ok: boolean;
  providerId: string;
  outputBaseDir: string;
  jsonReportPath: string;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFixtureResponse(
  fixtureRoot: string,
  tokenUsage?: FixtureTokenUsage,
): void {
  writeJson(join(fixtureRoot, 'responses', 'wait-for-output.json'), {
    response: PASSING_WAIT_RESPONSE,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  });
}

function createFixtureProviderDirectory(
  fixtureRoot: string,
  tokenUsage?: FixtureTokenUsage,
): void {
  writeJson(join(fixtureRoot, 'runtime-info.json'), {
    providerId: 'fixture',
    available: true,
    detectedAt: '2026-01-01T00:00:00.000Z',
    version: 'fixture',
    commandPath: 'fixture',
    defaultModelId: FIXTURE_MODEL,
    capabilities: {
      supportsDetect: true,
      supportsPlanMode: true,
      supportsAgentMode: true,
      supportsStreaming: false,
      supportsToolCalls: true,
      supportsTranscriptCapture: true,
    },
    notes: ['eval snapshot integration fixture'],
  });
  writeFixtureResponse(fixtureRoot, tokenUsage);
}

function runEvalCli(
  argumentsList: readonly string[],
  env: Record<string, string>,
) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './evals/run.ts', ...argumentsList],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
      },
      timeout: DEFAULT_EVAL_TIMEOUT_MS,
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return result;
}

function parseRunSummary(stdout: string): EvalRunSummary {
  return JSON.parse(stdout) as EvalRunSummary;
}

function readJsonReport(summary: EvalRunSummary): JsonReport {
  const parsed = JSON.parse(
    readFileSync(summary.jsonReportPath, 'utf8'),
  ) as JsonReport;

  expect(parsed).toHaveProperty('metadata');
  expect(parsed).toHaveProperty('aggregate');
  expect(Array.isArray(parsed.results)).toBe(true);
  return parsed;
}

function readSnapshotEntries(path: string): SnapshotEntry[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SnapshotEntry);
}

function buildFixtureEnv(
  testRoot: string,
  fixtureRoot: string,
  homeName: string,
) {
  const homeDir = join(testRoot, homeName);
  mkdirSync(homeDir, { recursive: true });
  return {
    AGENT_TTY_HOME: homeDir,
    EVAL_FIXTURE_DIR: fixtureRoot,
  };
}

function buildSharedFixtureArgs(outputDir: string): string[] {
  return [
    '--provider',
    'fixture',
    '--lane',
    'prompt',
    '--case',
    'wait-for-output',
    '--condition',
    'none',
    '--trials',
    '2',
    '--output',
    outputDir,
    '--json',
  ];
}

function projectNonTokenResults(report: JsonReport) {
  return report.results.map((result) => ({
    lane: result.lane,
    caseId: result.caseId,
    condition: result.condition,
    trial: result.trial,
    ok: result.ok,
    score: result.score.total,
    errorClass: result.errorClass ?? null,
    errorMessage: result.errorMessage ?? null,
  }));
}

let testRoot = '';

describe(
  'eval CLI token snapshot orchestration',
  { timeout: DEFAULT_EVAL_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      testRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'agent-tty-evals-snapshots-')),
      );
    });

    afterEach(() => {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    });

    it('writes token snapshots, reports unchanged/regressed checks, and preserves non-token aggregates', () => {
      const fixtureRoot = join(testRoot, 'fixture');
      const snapshotDir = join(testRoot, 'snapshots');
      createFixtureProviderDirectory(fixtureRoot, BASELINE_TOKEN_USAGE);

      const updateOutputDir = join(testRoot, 'update-output');
      const updateSummary = parseRunSummary(
        runEvalCli(
          [
            ...buildSharedFixtureArgs(updateOutputDir),
            '--snapshot-update',
            '--snapshot-dir',
            snapshotDir,
          ],
          buildFixtureEnv(testRoot, fixtureRoot, 'home-update'),
        ).stdout,
      );
      expect(updateSummary.ok).toBe(true);

      const updateReport = readJsonReport(updateSummary);
      expect(updateReport.tokenReport).toMatchObject({
        grandTotal: {
          inputTokens: 160,
          outputTokens: 40,
          totalTokens: 200,
          cachedTokens: 20,
          trials: 2,
        },
        perLane: [
          {
            lane: 'prompt',
            inputTokens: 160,
            outputTokens: 40,
            totalTokens: 200,
            cachedTokens: 20,
            trials: 2,
          },
        ],
        perCase: [
          {
            lane: 'prompt',
            caseId: 'wait-for-output',
            condition: 'none',
            inputTokens: 160,
            outputTokens: 40,
            totalTokens: 200,
            cachedTokens: 20,
            trials: 2,
          },
        ],
      });
      expect(updateReport.tokenReport?.snapshotCheck).toBeUndefined();

      const writtenSnapshotPath = snapshotFilePath(
        snapshotDir,
        'fixture',
        FIXTURE_MODEL,
      );
      expect(existsSync(writtenSnapshotPath)).toBe(true);
      expect(readSnapshotEntries(writtenSnapshotPath)).toEqual([
        expect.objectContaining({
          provider: 'fixture',
          model: FIXTURE_MODEL,
          lane: 'prompt',
          caseId: 'wait-for-output',
          condition: 'none',
          inputTokens: 160,
          outputTokens: 40,
          totalTokens: 200,
          cachedTokens: 20,
        }),
      ]);

      const unchangedOutputDir = join(testRoot, 'unchanged-output');
      const unchangedSummary = parseRunSummary(
        runEvalCli(
          [
            ...buildSharedFixtureArgs(unchangedOutputDir),
            '--snapshot-check',
            '--snapshot-dir',
            snapshotDir,
          ],
          buildFixtureEnv(testRoot, fixtureRoot, 'home-unchanged'),
        ).stdout,
      );
      const unchangedReport = readJsonReport(unchangedSummary);
      expect(unchangedSummary.ok).toBe(updateSummary.ok);
      expect(unchangedReport.aggregate).toEqual(updateReport.aggregate);
      expect(projectNonTokenResults(unchangedReport)).toEqual(
        projectNonTokenResults(updateReport),
      );
      expect(unchangedReport.tokenReport?.snapshotCheck).toMatchObject({
        regressionThresholdPercent: 20,
        summary: {
          total: 1,
          new: 0,
          orphaned: 0,
          unchanged: 1,
          improved: 0,
          regressed: 0,
        },
        cases: [
          expect.objectContaining({
            provider: 'fixture',
            model: FIXTURE_MODEL,
            lane: 'prompt',
            caseId: 'wait-for-output',
            condition: 'none',
            outcome: 'unchanged',
            currentTotalTokens: 200,
            snapshotTotalTokens: 200,
            deltaTokens: 0,
            deltaPercent: 0,
          }),
        ],
      });

      writeFixtureResponse(fixtureRoot, REGRESSED_TOKEN_USAGE);
      const regressionOutputDir = join(testRoot, 'regression-output');
      const regressionSummary = parseRunSummary(
        runEvalCli(
          [
            ...buildSharedFixtureArgs(regressionOutputDir),
            '--snapshot-check',
            '--snapshot-dir',
            snapshotDir,
            '--snapshot-threshold',
            '20',
          ],
          buildFixtureEnv(testRoot, fixtureRoot, 'home-regression'),
        ).stdout,
      );
      const regressionReport = readJsonReport(regressionSummary);
      expect(regressionSummary.ok).toBe(updateSummary.ok);
      expect(regressionReport.aggregate).toEqual(updateReport.aggregate);
      expect(projectNonTokenResults(regressionReport)).toEqual(
        projectNonTokenResults(updateReport),
      );
      expect(
        regressionReport.tokenReport?.snapshotCheck?.summary.regressed,
      ).toBe(1);
      expect(regressionReport.tokenReport?.snapshotCheck?.cases).toEqual([
        expect.objectContaining({
          provider: 'fixture',
          model: FIXTURE_MODEL,
          lane: 'prompt',
          caseId: 'wait-for-output',
          condition: 'none',
          outcome: 'regressed',
          currentTotalTokens: 260,
          snapshotTotalTokens: 200,
          deltaTokens: 60,
          deltaPercent: 30,
        }),
      ]);
    });

    it('uses the default snapshot directory and default threshold when flags are omitted', () => {
      const fixtureRoot = join(testRoot, 'fixture-defaults');
      const outputDir = join(testRoot, 'default-output');
      createFixtureProviderDirectory(fixtureRoot, BASELINE_TOKEN_USAGE);

      const updateSummary = parseRunSummary(
        runEvalCli(
          [...buildSharedFixtureArgs(outputDir), '--snapshot-update'],
          buildFixtureEnv(testRoot, fixtureRoot, 'home-default-update'),
        ).stdout,
      );
      const defaultSnapshotPath = snapshotFilePath(
        join(outputDir, 'snapshots'),
        'fixture',
        FIXTURE_MODEL,
      );
      expect(existsSync(defaultSnapshotPath)).toBe(true);
      expect(
        readJsonReport(updateSummary).tokenReport?.snapshotCheck,
      ).toBeUndefined();

      const checkSummary = parseRunSummary(
        runEvalCli(
          [...buildSharedFixtureArgs(outputDir), '--snapshot-check'],
          buildFixtureEnv(testRoot, fixtureRoot, 'home-default-check'),
        ).stdout,
      );
      expect(
        readJsonReport(checkSummary).tokenReport?.snapshotCheck,
      ).toMatchObject({
        regressionThresholdPercent: 20,
        summary: {
          total: 1,
          new: 0,
          orphaned: 0,
          unchanged: 1,
          improved: 0,
          regressed: 0,
        },
      });
    });

    it('rejects conflicting snapshot modes before creating output or snapshot directories', () => {
      const outputDir = join(testRoot, 'conflict-output');
      const snapshotDir = join(testRoot, 'conflict-snapshots');
      const result = runEvalCli(
        [
          '--provider',
          'stub',
          '--lane',
          'execution',
          '--case',
          'hello-prompt',
          '--condition',
          'none',
          '--output',
          outputDir,
          '--snapshot-dir',
          snapshotDir,
          '--snapshot-update',
          '--snapshot-check',
          '--dry-run',
          '--json',
        ],
        {
          AGENT_TTY_HOME: join(testRoot, 'home-conflict'),
        },
      );

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout) as { error: string }).toMatchObject({
        error: '--snapshot-update and --snapshot-check may not be combined',
      });
      expect(existsSync(outputDir)).toBe(false);
      expect(existsSync(snapshotDir)).toBe(false);
    });

    it.each(['NaN', '-1', '101'])(
      'rejects invalid snapshot thresholds at parse time: %s',
      (threshold) => {
        const result = runEvalCli(
          [
            '--provider',
            'stub',
            '--lane',
            'execution',
            '--case',
            'hello-prompt',
            '--condition',
            'none',
            '--snapshot-check',
            '--snapshot-threshold',
            threshold,
            '--dry-run',
            '--json',
          ],
          {
            AGENT_TTY_HOME: join(testRoot, `home-threshold-${threshold}`),
          },
        );

        expect(result.status).toBe(1);
        expect(
          (JSON.parse(result.stdout) as { error: string }).error,
        ).toContain('--snapshot-threshold must be a number between 0 and 100');
      },
    );

    it('keeps the legacy report shape and writes no snapshots when trials omit token usage', () => {
      const fixtureRoot = join(testRoot, 'fixture-no-token');
      const outputDir = join(testRoot, 'no-token-output');
      createFixtureProviderDirectory(fixtureRoot);

      const summary = parseRunSummary(
        runEvalCli(
          buildSharedFixtureArgs(outputDir),
          buildFixtureEnv(testRoot, fixtureRoot, 'home-no-token'),
        ).stdout,
      );
      expect(summary.ok).toBe(true);

      const report = readJsonReport(summary);
      expect(report).not.toHaveProperty('tokenReport');
      expect(existsSync(join(outputDir, 'snapshots'))).toBe(false);
    });
  },
);
