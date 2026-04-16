import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

interface EvalDryRunSummary {
  ok: boolean;
  providerId: string;
  lanes: string[];
  conditions: string[];
  totalInvocations: number;
  dryRun: boolean;
}

function runEvalCli(argumentsList: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './evals/run.ts', ...argumentsList],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return result;
}

describe('eval CLI trials flag', () => {
  it('shows --trials in the help output', () => {
    const result = runEvalCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--trials <n>');
  });

  it('multiplies prompt dry-run invocations by the requested trials', () => {
    const result = runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'prompt',
      '--condition',
      'none',
      '--trials',
      '3',
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as EvalDryRunSummary;
    expect(summary).toMatchObject({
      providerId: 'stub',
      lanes: ['prompt'],
      conditions: ['none'],
      totalInvocations: 72,
      dryRun: true,
      ok: true,
    });
  });

  it('multiplies execution dry-run invocations by the requested trials', () => {
    const result = runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'execution',
      '--condition',
      'none',
      '--trials',
      '2',
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as EvalDryRunSummary;
    expect(summary).toMatchObject({
      providerId: 'stub',
      lanes: ['execution'],
      conditions: ['none'],
      totalInvocations: 20,
      dryRun: true,
      ok: true,
    });
  });

  it('multiplies dogfood dry-run invocations by the requested trials', () => {
    const result = runEvalCli([
      '--provider',
      'stub',
      '--lane',
      'dogfood',
      '--condition',
      'none',
      '--trials',
      '2',
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as EvalDryRunSummary;
    expect(summary).toMatchObject({
      providerId: 'stub',
      lanes: ['dogfood'],
      conditions: ['none'],
      totalInvocations: 12,
      dryRun: true,
      ok: true,
    });
  });
});
