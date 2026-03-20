import { describe, expect, it } from 'vitest';

import { runCli, type SuccessEnvelope } from '../helpers.js';

describe('CLI integration', () => {
  it('prints a JSON envelope for version', () => {
    const result = runCli(['version', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      cliVersion: string;
    }>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('version');
    expect(parsed.result.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints a JSON envelope for doctor', () => {
    const result = runCli(['doctor', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      ok: boolean;
      checks: {
        environment: Array<{ name: string; status: string }>;
        renderer: Array<{ name: string; status: string }>;
      };
    }>;

    const allChecks = [
      ...parsed.result.checks.environment,
      ...parsed.result.checks.renderer,
    ];

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('doctor');
    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.checks.environment.length).toBeGreaterThan(0);
    expect(parsed.result.checks.renderer.length).toBeGreaterThan(0);
    expect(allChecks.every((check) => check.status === 'pass')).toBe(true);
  });
});
