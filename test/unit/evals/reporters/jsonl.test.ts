import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonlReporter } from '../../../../evals/reporters/jsonl.js';

import {
  createCaseFinishEvent,
  createCaseStartEvent,
  createLaneFinishEvent,
  createLaneStartEvent,
  createRunFinishEvent,
  createRunStartEvent,
  createTrialFinishEvent,
  createTrialStartEvent,
} from './fixtures.js';

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const tempDirs: string[] = [];

async function readJsonlRecords(outputPath: string): Promise<
  Array<{ type: string; timestamp: string; payload: Record<string, unknown> }>
> {
  const content = await fs.readFile(outputPath, 'utf8');
  const lines = content.trimEnd().split('\n');
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>) as Array<{
    type: string;
    timestamp: string;
    payload: Record<string, unknown>;
  }>;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('JsonlReporter', () => {
  it('appends ordered JSONL event records and creates parent directories once', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'jsonl-reporter-'));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, 'nested', 'events.jsonl');
    const reporter = new JsonlReporter({ outputPath });

    await reporter.onRunStart(createRunStartEvent({ runId: 'run-jsonl' }));
    await reporter.onLaneStart(
      createLaneStartEvent({ runId: 'run-jsonl', lane: 'execution' }),
    );
    await reporter.onCaseStart(
      createCaseStartEvent({ runId: 'run-jsonl', lane: 'execution' }),
    );
    await reporter.onTrialStart(
      createTrialStartEvent({ runId: 'run-jsonl', lane: 'execution' }),
    );
    await reporter.onTrialFinish(
      createTrialFinishEvent({ runId: 'run-jsonl', lane: 'execution' }),
    );
    await reporter.onCaseFinish(
      createCaseFinishEvent({ runId: 'run-jsonl', lane: 'execution' }),
    );
    await reporter.onLaneFinish(
      createLaneFinishEvent({ runId: 'run-jsonl', lane: 'execution' }),
    );
    await reporter.onRunFinish(createRunFinishEvent({ runId: 'run-jsonl' }));

    const records = await readJsonlRecords(outputPath);

    expect(records).toHaveLength(8);
    expect(records.map((record) => record.type)).toEqual([
      'run.start',
      'lane.start',
      'case.start',
      'trial.start',
      'trial.finish',
      'case.finish',
      'lane.finish',
      'run.finish',
    ]);
    expect(records[0]?.payload).toMatchObject({
      runId: 'run-jsonl',
      provider: 'stub',
    });
    expect(records[1]?.payload).toMatchObject({
      runId: 'run-jsonl',
      lane: 'execution',
    });
    expect(records[2]?.payload).toMatchObject({
      caseId: 'case-1',
      condition: 'none',
    });
    expect(records[3]?.payload).toMatchObject({
      trial: 1,
      requestedOutputPath: null,
    });
    expect(records[4]?.payload).toMatchObject({
      status: 'passed',
      ok: true,
      score: 0.5,
    });
    expect(records[5]?.payload).toMatchObject({
      meanScore: 0.5,
      durationMs: 2000,
    });
    expect(records[6]?.payload).toMatchObject({
      total: 1,
      passed: 1,
    });
    expect(records[7]?.payload).toMatchObject({
      reportJsonPath: '/tmp/evals/run-123/report.json',
      reportMarkdownPath: '/tmp/evals/run-123/report.md',
    });
    for (const record of records) {
      expect(record.timestamp).toMatch(ISO_TIMESTAMP_PATTERN);
    }
    expect(await fs.readFile(outputPath, 'utf8')).toContain('\n');
  });

  it('rejects empty or non-string output paths', () => {
    expect(() => new JsonlReporter({ outputPath: '' })).toThrow(
      'jsonl reporter outputPath must not be empty',
    );
    expect(
      () => new JsonlReporter({ outputPath: 123 as unknown as string }),
    ).toThrow('jsonl reporter outputPath must be a string');
  });
});
