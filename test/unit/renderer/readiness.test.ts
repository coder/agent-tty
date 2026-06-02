import { describe, expect, it } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import {
  assertDashboardRendererAvailable,
  buildDashboardCapability,
  probeLibghosttyVt,
  type LibghosttyVtProbe,
} from '../../../src/renderer/readiness.js';

describe('probeLibghosttyVt', () => {
  it('reports available when the native module exposes createTerminal', async () => {
    const probe = await probeLibghosttyVt(() =>
      Promise.resolve({ createTerminal: () => ({}) }),
    );

    expect(probe.available).toBe(true);
  });

  it('reports unavailable when the loaded module is missing createTerminal', async () => {
    const probe = await probeLibghosttyVt(() => Promise.resolve({}));

    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('libghostty-vt module is incomplete');
  });

  it('reports unavailable with the import error detail when the module cannot load', async () => {
    const probe = await probeLibghosttyVt(() =>
      Promise.reject(
        new Error('Cannot find package @coder/libghostty-vt-node'),
      ),
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBe('libghostty-vt not installed');
    expect(probe.detail).toContain(
      'Cannot find package @coder/libghostty-vt-node',
    );
  });
});

describe('assertDashboardRendererAvailable', () => {
  it('does nothing when the renderer is available', () => {
    expect(() =>
      assertDashboardRendererAvailable({ available: true }),
    ).not.toThrow();
  });

  it('throws an actionable INVALID_INPUT error naming the optional package when absent', () => {
    let caught: unknown;
    try {
      assertDashboardRendererAvailable({
        available: false,
        reason: 'libghostty-vt not installed',
        detail: 'Cannot find package @coder/libghostty-vt-node',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    const error = caught as CliError;
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('@coder/libghostty-vt-node');
    expect(error.message).toContain('doctor');
  });
});

describe('buildDashboardCapability', () => {
  const available: LibghosttyVtProbe = {
    available: true,
    reason: 'libghostty-vt native module available',
    detail: 'exposes createTerminal()',
  };

  it('returns a bare available entry in quick mode', () => {
    expect(buildDashboardCapability(available, 'quick')).toEqual({
      name: 'dashboard',
      status: 'available',
    });
  });

  it('includes reason and detail in full mode', () => {
    expect(buildDashboardCapability(available, 'full')).toEqual({
      name: 'dashboard',
      status: 'available',
      reason: 'libghostty-vt native module available',
      detail: 'exposes createTerminal()',
    });
  });

  it('reports unavailable with reason and detail when the probe failed', () => {
    expect(
      buildDashboardCapability(
        {
          available: false,
          reason: 'libghostty-vt not installed',
          detail: 'nope',
        },
        'full',
      ),
    ).toEqual({
      name: 'dashboard',
      status: 'unavailable',
      reason: 'libghostty-vt not installed',
      detail: 'nope',
    });
  });
});
