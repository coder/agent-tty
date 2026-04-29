import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const EXPECTED_JSONL_EVENT_TYPES = [
  'run.start',
  'lane.start',
  'case.start',
  'trial.start',
  'trial.finish',
  'trial.start',
  'trial.finish',
  'case.finish',
  'lane.finish',
  'run.finish',
] as const;

interface EvalRunSummary {
  runId?: string;
  jsonReportPath?: string;
  markdownReportPath?: string;
}

interface JsonlEventRecord {
  type: string;
  payload: {
    runId: string;
  };
}

function expectNonEmptyString(value: unknown, label: string): string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function findFilesNamed(rootDir: string, fileName: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const matches: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findFilesNamed(entryPath, fileName));
      continue;
    }
    if (entry.isFile() && entry.name === fileName) {
      matches.push(entryPath);
    }
  }

  return matches;
}

function runJsonlEval(
  homeDir: string,
  outputDir: string,
  reporterOutputPath: string,
): EvalRunSummary {
  mkdirSync(homeDir, { recursive: true });

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
      '--reporter',
      'jsonl',
      '--reporter-output',
      reporterOutputPath,
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
  'eval reporter jsonl integration',
  { timeout: DEFAULT_EVAL_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      // oxfmt-ignore
      testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-evals-reporter-jsonl-')));
    });

    afterEach(() => {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    });

    it('writes only JSONL events while keeping stdout as a single RunSummary object', () => {
      const homeDir = join(testRoot, 'home');
      const outputDir = join(testRoot, 'run');
      const reporterOutputPath = join(testRoot, 'events', 'reporter.jsonl');

      const summary = runJsonlEval(homeDir, outputDir, reporterOutputPath);
      const runId = expectNonEmptyString(summary.runId, 'summary.runId');

      expect(summary.jsonReportPath).toBeUndefined();
      expect('jsonReportPath' in summary).toBe(false);
      expect(summary.markdownReportPath).toBeUndefined();
      expect('markdownReportPath' in summary).toBe(false);
      expect(findFilesNamed(outputDir, 'report.json')).toEqual([]);
      expect(findFilesNamed(outputDir, 'report.md')).toEqual([]);

      expect(existsSync(reporterOutputPath)).toBe(true);
      const jsonlContent = readFileSync(reporterOutputPath, 'utf8');
      const lines = jsonlContent
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(10);

      const events = lines.map((line) => JSON.parse(line) as JsonlEventRecord);
      expect(events.map((event) => event.type)).toEqual(
        EXPECTED_JSONL_EVENT_TYPES,
      );
      expect(new Set(events.map((event) => event.payload.runId))).toEqual(
        new Set([runId]),
      );
    });
  },
);
