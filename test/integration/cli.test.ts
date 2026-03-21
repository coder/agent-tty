import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type SuccessEnvelope } from '../helpers.js';

let testHome = '';

function testEnv(): Record<string, string> {
  return { AGENT_TERMINAL_HOME: testHome };
}

describe('CLI integration', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'agent-terminal-cli-home-'));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    testHome = '';
  });

  it('prints a JSON envelope for version', () => {
    const result = runCli(['version', '--json'], testEnv());
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      cliVersion: string;
    }>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('version');
    expect(parsed.result.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints a JSON envelope for doctor including the new health checks', () => {
    const result = runCli(['doctor', '--json'], testEnv());
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
    expect(parsed.result.checks.environment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'home-writable', status: 'pass' }),
        expect.objectContaining({ name: 'pty-spawn', status: 'pass' }),
        expect.objectContaining({ name: 'socket-viable', status: 'pass' }),
        expect.objectContaining({
          name: 'artifact-atomicity',
          status: 'pass',
        }),
        expect.objectContaining({
          name: 'event-log-writable',
          status: 'pass',
        }),
      ]),
    );
    expect(parsed.result.checks.renderer.length).toBeGreaterThan(0);
    expect(allChecks.every((check) => check.status === 'pass')).toBe(true);
  });
});
