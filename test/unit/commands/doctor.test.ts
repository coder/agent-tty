import { describe, expect, it } from 'vitest';

import {
  buildDoctorLines,
  runDoctorChecks,
} from '../../../src/cli/commands/doctor.js';

describe('doctor command', () => {
  it('returns unique passing checks across environment and renderer groups', async () => {
    const result = await runDoctorChecks();
    const allChecks = [...result.checks.environment, ...result.checks.renderer];
    const checkNames = allChecks.map((check) => check.name);

    expect(result.ok).toBe(true);
    expect(result.checks.environment.length).toBeGreaterThan(0);
    expect(result.checks.renderer.length).toBeGreaterThan(0);
    expect(new Set(checkNames).size).toBe(checkNames.length);
    expect(allChecks.every((check) => check.status === 'pass')).toBe(true);
    expect(
      allChecks.every((check) => typeof check.durationMs === 'number'),
    ).toBe(true);
  });

  it('formats grouped human-readable output', () => {
    const lines = buildDoctorLines({
      ok: false,
      checks: {
        environment: [
          {
            name: 'node-runtime',
            status: 'pass',
            message: 'Node v24.1.0 ok',
            durationMs: 1,
          },
        ],
        renderer: [
          {
            name: 'playwright_available',
            status: 'fail',
            message: 'playwright missing',
            durationMs: 2,
          },
          {
            name: 'screenshot_viable',
            status: 'skip',
            message: 'not attempted',
            durationMs: 3,
          },
        ],
      },
    });

    expect(lines).toEqual([
      'Environment:',
      '  ✓ node: Node v24.1.0 ok',
      '',
      'Renderer:',
      '  ✗ playwright: playwright missing',
      '  ○ screenshot: not attempted',
    ]);
  });
});
