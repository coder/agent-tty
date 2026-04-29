import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/gu;

interface EvalRunSummary {
  runId?: string;
  outputBaseDir: string;
  jsonReportPath?: string;
  markdownReportPath?: string;
}

interface NormalizationContext {
  outputBaseDir: string;
  runId: string;
}

function expectNonEmptyString(value: unknown, label: string): string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeStringValue(
  value: string,
  context: NormalizationContext,
): string {
  return value
    .replaceAll(context.outputBaseDir, '<OUTPUT_DIR>')
    .replaceAll(context.runId, '<RUN_ID>')
    .replace(ISO_TIMESTAMP_PATTERN, '<TIMESTAMP>');
}

function normalizeJsonReportValue(
  value: unknown,
  context: NormalizationContext,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonReportValue(item, context));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        normalizeJsonReportValue(nestedValue, context, nestedKey),
      ]),
    );
  }

  if (typeof value === 'string') {
    return normalizeStringValue(value, context);
  }

  if (typeof value === 'number' && key !== undefined && key.endsWith('Ms')) {
    return 0;
  }

  return value;
}

function runEval(
  homeDir: string,
  outputDir: string,
  reporters: readonly string[] = [],
): EvalRunSummary {
  mkdirSync(homeDir, { recursive: true });

  const reporterArgs = reporters.flatMap((reporterName) => [
    '--reporter',
    reporterName,
  ]);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      './evals/run.ts',
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--case',
      'pure-reasoning',
      '--condition',
      'none',
      '--trials',
      '2',
      '--concurrency',
      '1',
      ...reporterArgs,
      '--output',
      outputDir,
      '--json',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_TTY_HOME: homeDir,
      },
      timeout: DEFAULT_EVAL_TIMEOUT_MS,
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return JSON.parse(result.stdout) as EvalRunSummary;
}

let testRoot = '';

describe(
  'eval reporter final/default parity',
  { timeout: DEFAULT_EVAL_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      // oxfmt-ignore
      testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-evals-reporter-final-')));
    });

    afterEach(() => {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    });

    it('matches the implicit default reporter output with explicit --reporter final', () => {
      const implicitSummary = runEval(
        join(testRoot, 'implicit-home'),
        join(testRoot, 'implicit-output'),
      );
      const explicitSummary = runEval(
        join(testRoot, 'explicit-home'),
        join(testRoot, 'explicit-output'),
        ['final'],
      );

      const implicitRunId = expectNonEmptyString(
        implicitSummary.runId,
        'implicitSummary.runId',
      );
      const explicitRunId = expectNonEmptyString(
        explicitSummary.runId,
        'explicitSummary.runId',
      );
      const implicitJsonReportPath = expectNonEmptyString(
        implicitSummary.jsonReportPath,
        'implicitSummary.jsonReportPath',
      );
      const explicitJsonReportPath = expectNonEmptyString(
        explicitSummary.jsonReportPath,
        'explicitSummary.jsonReportPath',
      );
      const implicitMarkdownReportPath = expectNonEmptyString(
        implicitSummary.markdownReportPath,
        'implicitSummary.markdownReportPath',
      );
      const explicitMarkdownReportPath = expectNonEmptyString(
        explicitSummary.markdownReportPath,
        'explicitSummary.markdownReportPath',
      );

      expect(existsSync(implicitJsonReportPath)).toBe(true);
      expect(existsSync(explicitJsonReportPath)).toBe(true);
      expect(existsSync(implicitMarkdownReportPath)).toBe(true);
      expect(existsSync(explicitMarkdownReportPath)).toBe(true);

      const implicitContext: NormalizationContext = {
        outputBaseDir: implicitSummary.outputBaseDir,
        runId: implicitRunId,
      };
      const explicitContext: NormalizationContext = {
        outputBaseDir: explicitSummary.outputBaseDir,
        runId: explicitRunId,
      };

      const implicitJsonReport = JSON.parse(
        readFileSync(implicitJsonReportPath, 'utf8'),
      ) as unknown;
      const explicitJsonReport = JSON.parse(
        readFileSync(explicitJsonReportPath, 'utf8'),
      ) as unknown;
      expect(
        normalizeJsonReportValue(implicitJsonReport, implicitContext),
      ).toEqual(normalizeJsonReportValue(explicitJsonReport, explicitContext));

      const implicitMarkdownReport = normalizeStringValue(
        readFileSync(implicitMarkdownReportPath, 'utf8'),
        implicitContext,
      );
      const explicitMarkdownReport = normalizeStringValue(
        readFileSync(explicitMarkdownReportPath, 'utf8'),
        explicitContext,
      );
      expect(implicitMarkdownReport).toBe(explicitMarkdownReport);
    });
  },
);
