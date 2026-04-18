import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateJsonReport,
  generateMarkdownReport,
} from '../../../../evals/lib/reporting.js';
import type {
  EvalResult,
  RunMetadata,
  TokenReportSummary,
} from '../../../../evals/lib/types.js';
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

function createTokenReportSummary(): TokenReportSummary {
  return {
    grandTotal: {
      inputTokens: 90,
      outputTokens: 30,
      totalTokens: 120,
      cachedTokens: 12,
      trials: 1,
    },
    perLane: [
      {
        lane: 'prompt',
        inputTokens: 90,
        outputTokens: 30,
        totalTokens: 120,
        cachedTokens: 12,
        trials: 1,
      },
    ],
    perCase: [
      {
        lane: 'prompt',
        caseId: 'case-1',
        condition: 'none',
        inputTokens: 90,
        outputTokens: 30,
        totalTokens: 120,
        cachedTokens: 12,
        trials: 1,
      },
    ],
    snapshotCheck: {
      regressionThresholdPercent: 10,
      cases: [
        {
          provider: 'stub',
          model: 'stub-model',
          lane: 'prompt',
          caseId: 'case-1',
          condition: 'none',
          caseFingerprint: 'b'.repeat(64),
          totalTokens: 120,
          outcome: 'unchanged',
          currentTotalTokens: 120,
          snapshotTotalTokens: 118,
          deltaTokens: 2,
          deltaPercent: 1.7,
        },
      ],
      summary: {
        total: 1,
        new: 0,
        orphaned: 0,
        unchanged: 1,
        improved: 0,
        regressed: 0,
      },
    },
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

  it('threads tokenReport into the written JSON and Markdown reports', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'final-report-token-'));
    tempDirs.push(tempDir);
    const results = [createEvalResult()];
    const metadata = createRunMetadata();
    const tokenReport = createTokenReportSummary();
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
        tokenReport,
      }),
    );

    const expectedJson = `${JSON.stringify(generateJsonReport(results, metadata, [], undefined, tokenReport), null, 2)}\n`;
    const expectedMarkdown = generateMarkdownReport(
      results,
      metadata,
      [],
      undefined,
      tokenReport,
    );
    const writtenJson = await fs.readFile(jsonReportPath, 'utf8');
    const writtenMarkdown = await fs.readFile(markdownReportPath, 'utf8');

    expect(writtenJson).toBe(expectedJson);
    expect(writtenMarkdown).toBe(expectedMarkdown);
    expect(JSON.parse(writtenJson)).toMatchObject({ tokenReport });
    expect(writtenMarkdown).toContain('## Token usage');
    expect(writtenMarkdown.indexOf('## Token usage')).toBeGreaterThan(
      writtenMarkdown.indexOf('## Anti-pattern summary'),
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
