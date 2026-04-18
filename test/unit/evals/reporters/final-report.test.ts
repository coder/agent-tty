import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateJsonReport,
  generateMarkdownReport,
} from '../../../../evals/lib/reporting.js';
import type { EvalResult, RunMetadata } from '../../../../evals/lib/types.js';
import { FinalReportReporter } from '../../../../evals/reporters/final-report.js';

import { createRunFinishEvent } from './fixtures.js';

const tempDirs: string[] = [];

function createRunMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runId: 'report-run',
    createdAt: '2026-01-01T00:00:00.000Z',
    repoRoot: '/tmp/report-repo',
    providers: ['stub'],
    models: ['stub-model'],
    lanes: ['prompt'],
    conditions: ['none'],
    totalTrials: 1,
    notes: [],
    ...overrides,
  };
}

function createEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    runId: 'report-run',
    providerId: 'stub',
    modelId: 'stub-model',
    lane: 'prompt',
    caseId: 'case-1',
    category: 'trigger',
    condition: 'none',
    expectedSkill: 'agent-tty',
    trial: 1,
    ok: true,
    score: { total: 1, maxPossible: 1, items: [] },
    workflowChecks: [],
    antiPatternFindings: [],
    normalizedOutput: {
      finalText: '',
      messages: [],
      referencedSkills: [],
      toolCalls: [],
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('FinalReportReporter', () => {
  it('writes report.json and report.md with byte-identical legacy serialization', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'final-report-reporter-'));
    tempDirs.push(tempDir);
    const results = [createEvalResult()];
    const metadata = createRunMetadata();
    const jsonReportPath = join(tempDir, 'report.json');
    const markdownReportPath = join(tempDir, 'report.md');
    const reporter = new FinalReportReporter({
      getFinalReportInputs: () => ({
        results,
        metadata,
        comparisonMetrics: [],
        jsonReportPath,
        markdownReportPath,
      }),
    });

    await reporter.onRunFinish(
      createRunFinishEvent({
        runId: metadata.runId,
        runDir: tempDir,
        reportJsonPath: jsonReportPath,
        reportMarkdownPath: markdownReportPath,
      }),
    );

    const expectedJson = `${JSON.stringify(generateJsonReport(results, metadata, [], undefined), null, 2)}\n`;
    const expectedMarkdown = generateMarkdownReport(
      results,
      metadata,
      [],
      undefined,
    );

    expect(await fs.readFile(jsonReportPath, 'utf8')).toBe(expectedJson);
    expect(await fs.readFile(markdownReportPath, 'utf8')).toBe(
      expectedMarkdown,
    );
  });

  it('is a no-op when final report inputs are unavailable', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'final-report-skip-'));
    tempDirs.push(tempDir);
    const jsonReportPath = join(tempDir, 'report.json');
    const markdownReportPath = join(tempDir, 'report.md');
    const reporter = new FinalReportReporter({
      getFinalReportInputs: () => null,
    });

    await expect(
      reporter.onRunFinish(
        createRunFinishEvent({
          runDir: tempDir,
          reportJsonPath: jsonReportPath,
          reportMarkdownPath: markdownReportPath,
        }),
      ),
    ).resolves.toBeUndefined();

    await expect(fs.access(jsonReportPath)).rejects.toThrow();
    await expect(fs.access(markdownReportPath)).rejects.toThrow();
  });
});
