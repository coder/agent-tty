import { spawnSync } from 'node:child_process';
import {
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

import type { CaseStartEvent } from '../../evals/reporters/types.js';

const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

interface EvalRunSummary {
  ok: boolean;
  outputBaseDir: string;
}

interface JsonlRecord<TPayload = Record<string, unknown>> {
  type: string;
  timestamp: string;
  payload: TPayload;
}

function readJsonlRecords(outputPath: string): JsonlRecord[] {
  const content = readFileSync(outputPath, 'utf8').trimEnd();
  expect(content.length).toBeGreaterThan(0);
  return content.split('\n').map((line) => JSON.parse(line) as JsonlRecord);
}

function getRequiredCaseStartPayload(
  records: readonly JsonlRecord[],
): CaseStartEvent {
  const caseStartRecords = records.filter(
    (record) => record.type === 'case.start',
  );

  expect(caseStartRecords).toHaveLength(1);
  const caseStartRecord = caseStartRecords[0];
  if (caseStartRecord === undefined) {
    throw new Error('Expected exactly one case.start record');
  }

  return caseStartRecord.payload as CaseStartEvent;
}

function runJsonlExecutionEval(
  testRoot: string,
  caseId: string,
): {
  summary: EvalRunSummary;
  records: JsonlRecord[];
} {
  const homeDir = join(testRoot, `${caseId}-home`);
  const outputDir = join(testRoot, `${caseId}-output`);
  const reporterOutputPath = join(testRoot, `${caseId}.jsonl`);

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      './evals/run.ts',
      '--provider',
      'stub',
      '--lane',
      'execution',
      '--case',
      caseId,
      '--condition',
      'none',
      '--trials',
      '1',
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

  return {
    summary: JSON.parse(result.stdout) as EvalRunSummary,
    records: readJsonlRecords(reporterOutputPath),
  };
}

let testRoot = '';

describe(
  'eval workspace preset reporting',
  { timeout: DEFAULT_EVAL_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      testRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'agent-tty-evals-workspace-presets-')),
      );
    });

    afterEach(() => {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    });

    it('includes the builtin workspace plan on case.start for hello-prompt', () => {
      const { records, summary } = runJsonlExecutionEval(
        testRoot,
        'hello-prompt',
      );
      const caseStartPayload = getRequiredCaseStartPayload(records);

      expect(summary.outputBaseDir).toBe(join(testRoot, 'hello-prompt-output'));
      expect(caseStartPayload.caseId).toBe('hello-prompt');
      expect(caseStartPayload.workspace).toBeDefined();
      expect(caseStartPayload.workspace?.presetId).toBe('agent-tty-smoke');
      expect(caseStartPayload.workspace?.bootstrapCount).toBe(1);
      expect(caseStartPayload.workspace?.cwd).toBeUndefined();
      expect(caseStartPayload.workspace?.env ?? {}).toEqual({});
    });

    it('omits the workspace block for legacy execution cases without a preset', () => {
      const { records } = runJsonlExecutionEval(testRoot, 'color-grid');
      const caseStartPayload = getRequiredCaseStartPayload(records);

      expect(caseStartPayload.caseId).toBe('color-grid');
      expect(caseStartPayload).not.toHaveProperty('workspace');
      expect(caseStartPayload.workspace).toBeUndefined();
    });
  },
);
