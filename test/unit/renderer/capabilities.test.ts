import { describe, expect, it, vi } from 'vitest';

import { discoverCapabilities } from '../../../src/renderer/capabilities.js';

function getCapability(
  capabilities: Awaited<ReturnType<typeof discoverCapabilities>>,
  name: (typeof capabilities)[number]['name'],
) {
  return capabilities.find((capability) => capability.name === name);
}

describe('discoverCapabilities', () => {
  it('returns five quick capabilities without browser-launch details', async () => {
    const probePlaywright = vi.fn(() => Promise.resolve({ available: true }));

    const capabilities = await discoverCapabilities('quick', {
      probePlaywright,
    });

    expect(probePlaywright).toHaveBeenCalledTimes(2);
    expect(capabilities).toHaveLength(5);
    expect(capabilities.map((capability) => capability.name)).toEqual([
      'snapshot',
      'wait',
      'screenshot',
      'record-export-asciicast',
      'record-export-webm',
    ]);
    expect(getCapability(capabilities, 'snapshot')).toEqual({
      name: 'snapshot',
      status: 'available',
    });
    expect(getCapability(capabilities, 'wait')).toEqual({
      name: 'wait',
      status: 'available',
    });
    expect(getCapability(capabilities, 'screenshot')).toEqual({
      name: 'screenshot',
      status: 'available',
    });
    expect(getCapability(capabilities, 'record-export-asciicast')).toEqual({
      name: 'record-export-asciicast',
      status: 'available',
    });
    expect(getCapability(capabilities, 'record-export-webm')).toEqual({
      name: 'record-export-webm',
      status: 'available',
    });
  });

  it('marks quick browser-backed capabilities unavailable when playwright is missing', async () => {
    const capabilities = await discoverCapabilities('quick', {
      probePlaywright: () =>
        Promise.resolve({
          available: false,
          reason: 'playwright not installed',
          detail: 'Cannot find package playwright',
        }),
    });

    expect(getCapability(capabilities, 'screenshot')).toEqual({
      name: 'screenshot',
      status: 'unavailable',
      reason: 'playwright not installed',
      detail: 'Cannot find package playwright',
    });
    expect(getCapability(capabilities, 'record-export-webm')).toEqual({
      name: 'record-export-webm',
      status: 'unavailable',
      reason: 'playwright not installed',
      detail: 'Cannot find package playwright',
    });
  });

  it('uses full doctor renderer checks without re-probing playwright', async () => {
    const probePlaywright = vi.fn(() => Promise.resolve({ available: true }));

    const capabilities = await discoverCapabilities('full', {
      probePlaywright,
      rendererChecks: [
        {
          name: 'playwright_available',
          status: 'pass',
          message: 'available',
        },
        {
          name: 'browser_launch',
          status: 'pass',
          message: 'chromium launches',
        },
        {
          name: 'ghostty_web_available',
          status: 'pass',
          message: 'WASM available',
        },
        {
          name: 'screenshot_viable',
          status: 'pass',
          message: 'viable',
        },
      ],
    });

    expect(probePlaywright).not.toHaveBeenCalled();
    expect(getCapability(capabilities, 'snapshot')).toEqual({
      name: 'snapshot',
      status: 'available',
      reason: 'built-in capability',
      detail: 'available without external renderer dependencies',
    });
    expect(getCapability(capabilities, 'screenshot')).toMatchObject({
      name: 'screenshot',
      status: 'available',
      reason: 'renderer smoke checks passed',
    });
    expect(getCapability(capabilities, 'screenshot')?.detail).toContain(
      'screenshot_viable: viable',
    );
    expect(getCapability(capabilities, 'record-export-webm')).toMatchObject({
      name: 'record-export-webm',
      status: 'available',
      reason: 'browser-backed export dependencies available',
    });
  });

  it('reports degraded full browser-backed capabilities from failing renderer checks', async () => {
    const capabilities = await discoverCapabilities('full', {
      rendererChecks: [
        {
          name: 'playwright_available',
          status: 'pass',
          message: 'available',
        },
        {
          name: 'browser_launch',
          status: 'fail',
          message: 'chromium binary missing',
        },
        {
          name: 'ghostty_web_available',
          status: 'pass',
          message: 'WASM available',
        },
        {
          name: 'screenshot_viable',
          status: 'fail',
          message: 'not attempted after browser failure',
        },
      ],
    });

    expect(getCapability(capabilities, 'screenshot')).toEqual({
      name: 'screenshot',
      status: 'degraded',
      reason: 'browser launch failed',
      detail: 'chromium binary missing',
    });
    expect(getCapability(capabilities, 'record-export-webm')).toEqual({
      name: 'record-export-webm',
      status: 'degraded',
      reason: 'browser launch failed',
      detail: 'chromium binary missing',
    });
  });
});
