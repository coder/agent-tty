import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SKILL_CONDITIONS } from '../../../evals/lib/matrix.js';
import {
  parseCliArgs,
  resolveReporterSelection,
  resolveRequestedConditions,
  runEvalCli,
} from '../../../evals/run.js';

function getWrittenStdout(calls: readonly unknown[][]): string {
  return calls
    .map((call) => {
      const [chunk] = call;
      expect(typeof chunk).toBe('string');
      if (typeof chunk !== 'string') {
        throw new Error('expected stdout to be written as a string');
      }
      return chunk;
    })
    .join('');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoPath(...segments: string[]): string {
  return resolve(
    fileURLToPath(new URL('../../..', import.meta.url)),
    ...segments,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCliArgs', () => {
  it('collects a single --condition value', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--condition',
      'none',
    ]);

    expect(options.conditions).toEqual(['none']);
  });

  it('collects repeated --condition values in CLI order', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--condition',
      'none',
      '--condition',
      'preloaded',
    ]);

    expect(options.conditions).toEqual(['none', 'preloaded']);
  });

  it('collects repeated --reporter values in CLI order', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--reporter',
      'jsonl',
      '--reporter',
      'console',
    ]);

    expect(options.reporters).toEqual(['jsonl', 'console']);
  });

  it('defaults to no explicit condition filters when --condition is omitted', () => {
    const options = parseCliArgs(['--provider', 'stub', '--lane', 'prompt']);

    expect(options.conditions).toEqual([]);
  });
  it('parses snapshot update flags and option values', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--snapshot-update',
      '--snapshot-threshold',
      '12.5',
      '--snapshot-dir',
      'tmp/snapshots',
    ]);

    expect(options.snapshotUpdate).toBe(true);
    expect(options.snapshotCheck).toBe(false);
    expect(options.snapshotThreshold).toBe('12.5');
    expect(options.snapshotDir).toBe('tmp/snapshots');
  });

  it('parses --snapshot-check independently from --snapshot-update', () => {
    const options = parseCliArgs([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--snapshot-check',
    ]);

    expect(options.snapshotUpdate).toBe(false);
    expect(options.snapshotCheck).toBe(true);
  });
});

describe('resolveRequestedConditions', () => {
  it('defaults to all conditions when no filters are provided', () => {
    expect(resolveRequestedConditions([])).toEqual(SKILL_CONDITIONS);
  });

  it('resolves a single condition', () => {
    expect(resolveRequestedConditions(['none'])).toEqual(['none']);
  });

  it('deduplicates repeated conditions and restores canonical ordering', () => {
    expect(
      resolveRequestedConditions(['preloaded', 'none', 'none', 'stale']),
    ).toEqual(['none', 'preloaded', 'stale']);
  });

  it('expands all when requested by itself', () => {
    expect(resolveRequestedConditions(['all'])).toEqual(SKILL_CONDITIONS);
    expect(resolveRequestedConditions(['all', 'all'])).toEqual(
      SKILL_CONDITIONS,
    );
  });

  it('rejects all when mixed with specific conditions', () => {
    expect(() => resolveRequestedConditions(['all', 'none'])).toThrow(
      '--condition all may not be combined with specific values',
    );
    expect(() => resolveRequestedConditions(['none', 'all'])).toThrow(
      '--condition all may not be combined with specific values',
    );
  });

  it('rejects invalid conditions', () => {
    expect(() => resolveRequestedConditions(['invalid'])).toThrow(
      'Unsupported condition: invalid. Expected one of none, self-load, preloaded, stale, all',
    );
  });
});

describe('resolveReporterSelection', () => {
  const repoRoot = resolveRepoPath();

  it('defaults to final when no reporters are provided', () => {
    expect(
      resolveReporterSelection(repoRoot, {
        reporters: [],
        progress: false,
      }),
    ).toEqual({ reporterNames: ['final'] });
  });

  it('adds console for --progress without duplicating an explicit console reporter', () => {
    expect(
      resolveReporterSelection(repoRoot, {
        reporters: ['jsonl'],
        reporterOutput: 'tmp/events.jsonl',
        progress: true,
      }),
    ).toEqual({
      reporterNames: ['jsonl', 'console'],
      reporterOutputPath: resolve(repoRoot, 'tmp/events.jsonl'),
    });

    expect(
      resolveReporterSelection(repoRoot, {
        reporters: ['console'],
        progress: true,
      }),
    ).toEqual({ reporterNames: ['console'] });
  });

  it('rejects unknown reporters', () => {
    expect(() =>
      resolveReporterSelection(repoRoot, {
        reporters: ['unknown'],
        progress: false,
      }),
    ).toThrow(
      'Unsupported reporter: unknown. Expected one of final, console, jsonl',
    );
  });

  it('rejects jsonl without --reporter-output', () => {
    expect(() =>
      resolveReporterSelection(repoRoot, {
        reporters: ['jsonl'],
        progress: false,
      }),
    ).toThrow('--reporter jsonl requires --reporter-output');
  });
});

describe('runEvalCli snapshot option validation', () => {
  it('rejects mutually exclusive snapshot update and check modes', async () => {
    await expect(
      runEvalCli([
        '--provider',
        'stub',
        '--lane',
        'execution',
        '--case',
        'hello-prompt',
        '--condition',
        'none',
        '--snapshot-update',
        '--snapshot-check',
        '--dry-run',
      ]),
    ).rejects.toThrow(
      '--snapshot-update and --snapshot-check may not be combined',
    );
  });

  it.each(['NaN', '-1', '101'])(
    'rejects invalid snapshot thresholds: %s',
    async (threshold) => {
      await expect(
        runEvalCli([
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
        ]),
      ).rejects.toThrow(
        '--snapshot-threshold must be a number between 0 and 100',
      );
    },
  );

  it('includes the snapshot options in --help output', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);

    const exitCode = await runEvalCli(['--help']);

    expect(exitCode).toBe(0);
    expect(
      getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
    ).toContain('--snapshot-update');
    expect(
      getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
    ).toContain('--snapshot-check');
    expect(
      getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
    ).toContain('--snapshot-threshold <percent>');
    expect(
      getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
    ).toContain('--snapshot-dir <path>');
  });
});

describe('runEvalCli dry-run output', () => {
  it('prints the resolved output directory in human-readable output', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const outputDir = resolveRepoPath('evals', 'reports', 'test-dry-run-human');

    const exitCode = await runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'execution',
      '--case',
      'hello-prompt',
      '--condition',
      'none',
      '--condition',
      'preloaded',
      '--output',
      'evals/reports/test-dry-run-human',
      '--dry-run',
    ]);

    expect(exitCode).toBe(0);
    expect(
      getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
    ).toContain(`Output directory: ${outputDir}\n`);
  });

  it('emits the resolved output directory in the JSON summary', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const outputDir = resolveRepoPath('evals', 'reports', 'test-dry-run-json');

    const exitCode = await runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'execution',
      '--case',
      'hello-prompt',
      '--condition',
      'none',
      '--condition',
      'preloaded',
      '--output',
      'evals/reports/test-dry-run-json',
      '--dry-run',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(
      JSON.parse(
        getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
      ) as { outputBaseDir: string },
    ).toMatchObject({ outputBaseDir: outputDir });
  });
});

describe('runEvalCli reporter output', () => {
  it('keeps stdout to one JSON object when non-final reporters are active', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true);
    const tempRoot = await mkdtemp(join(tmpdir(), 'agent-tty-evals-run-'));
    const outputDir = join(tempRoot, 'reports');
    const reporterOutputPath = join(tempRoot, 'events.jsonl');

    try {
      await runEvalCli([
        '--provider',
        'stub',
        '--lane',
        'prompt',
        '--case',
        'pure-reasoning',
        '--condition',
        'none',
        '--output',
        outputDir,
        '--reporter',
        'jsonl',
        '--reporter-output',
        reporterOutputPath,
        '--progress',
        '--json',
      ]);

      expect(stdoutWriteSpy.mock.calls).toHaveLength(1);
      expect(stderrWriteSpy.mock.calls.length).toBeGreaterThan(0);

      const summary = JSON.parse(
        getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]),
      ) as {
        outputBaseDir: string;
        runDir?: string;
        jsonReportPath?: string;
        markdownReportPath?: string;
      };

      expect(summary).toMatchObject({ outputBaseDir: outputDir });
      expect(summary).not.toHaveProperty('jsonReportPath');
      expect(summary).not.toHaveProperty('markdownReportPath');
      expect(typeof summary.runDir).toBe('string');
      if (typeof summary.runDir !== 'string') {
        throw new Error('expected runDir in JSON summary');
      }

      expect(await pathExists(join(summary.runDir, 'report.json'))).toBe(false);
      expect(await pathExists(join(summary.runDir, 'report.md'))).toBe(false);

      const jsonlOutput = await readFile(reporterOutputPath, 'utf8');
      expect(jsonlOutput).toContain('"type":"run.start"');
      expect(jsonlOutput).toContain('"type":"run.finish"');
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
