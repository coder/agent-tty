import { describe, expect, it, vi } from 'vitest';

import { discoverCapabilities } from '../../../src/renderer/capabilities.js';

function getCapability(
  capabilities: Awaited<ReturnType<typeof discoverCapabilities>>,
  name: (typeof capabilities)[number]['name'],
) {
  return capabilities.find((capability) => capability.name === name);
}

describe('discoverCapabilities', () => {
  it('returns six quick capabilities without browser-launch details', async () => {
    const probePlaywright = vi.fn(() => Promise.resolve({ available: true }));
    const probeLibghosttyVt = vi.fn(() => Promise.resolve({ available: true }));

    const capabilities = await discoverCapabilities('quick', {
      probePlaywright,
      probeLibghosttyVt,
    });

    expect(probePlaywright).toHaveBeenCalledTimes(1);
    expect(probeLibghosttyVt).toHaveBeenCalledTimes(1);
    expect(capabilities).toHaveLength(6);
    expect(capabilities.map((capability) => capability.name)).toEqual([
      'snapshot',
      'wait',
      'screenshot',
      'record-export-asciicast',
      'record-export-webm',
      'dashboard',
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
    expect(getCapability(capabilities, 'dashboard')).toEqual({
      name: 'dashboard',
      status: 'available',
    });
  });

  it('marks the quick dashboard capability unavailable when libghostty-vt is missing', async () => {
    const capabilities = await discoverCapabilities('quick', {
      probePlaywright: () => Promise.resolve({ available: true }),
      probeLibghosttyVt: () =>
        Promise.resolve({
          available: false,
          reason: 'libghostty-vt not installed',
          detail: 'Cannot find package @coder/libghostty-vt-node',
        }),
    });

    expect(getCapability(capabilities, 'dashboard')).toEqual({
      name: 'dashboard',
      status: 'unavailable',
      reason: 'libghostty-vt not installed',
      detail: 'Cannot find package @coder/libghostty-vt-node',
    });
  });

  it('marks quick browser-backed capabilities unavailable when playwright is missing', async () => {
    const capabilities = await discoverCapabilities('quick', {
      probeLibghosttyVt: () => Promise.resolve({ available: true }),
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

  it('uses ghostty-web as the quick semantic fallback when libghostty-vt is missing', async () => {
    const capabilities = await discoverCapabilities('quick', {
      probeLibghosttyVt: () =>
        Promise.resolve({
          available: false,
          reason: 'libghostty-vt not installed',
          detail: 'missing optional native package',
        }),
      probePlaywright: () => Promise.resolve({ available: true }),
    });

    expect(getCapability(capabilities, 'snapshot')).toEqual({
      name: 'snapshot',
      status: 'available',
    });
    expect(getCapability(capabilities, 'wait')).toEqual({
      name: 'wait',
      status: 'available',
    });
  });

  it('marks quick semantic capabilities unavailable when no renderer can serve them', async () => {
    const capabilities = await discoverCapabilities('quick', {
      probeLibghosttyVt: () =>
        Promise.resolve({
          available: false,
          reason: 'libghostty-vt not installed',
          detail: 'missing optional native package',
        }),
      probePlaywright: () =>
        Promise.resolve({
          available: false,
          reason: 'playwright not installed',
          detail: 'missing browser renderer package',
        }),
    });

    expect(getCapability(capabilities, 'snapshot')).toEqual({
      name: 'snapshot',
      status: 'unavailable',
      reason: 'semantic renderer unavailable',
      detail:
        'missing optional native package; missing browser renderer package',
    });
    expect(getCapability(capabilities, 'wait')).toEqual({
      name: 'wait',
      status: 'degraded',
      reason: 'render waits unavailable',
      detail:
        'legacy --exit and --idle-ms wait modes remain available; missing optional native package; missing browser renderer package',
    });
  });

  it('uses full doctor renderer checks without re-probing playwright', async () => {
    const probePlaywright = vi.fn(() => Promise.resolve({ available: true }));

    const capabilities = await discoverCapabilities('full', {
      probePlaywright,
      rendererChecks: [
        {
          name: 'libghostty_vt_available',
          status: 'pass',
          message: 'native available',
        },
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
      reason: 'libghostty-vt semantic renderer available',
      detail: 'native available',
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

  it('keeps full wait degraded when render dependencies are unavailable', async () => {
    const capabilities = await discoverCapabilities('full', {
      rendererChecks: [
        {
          name: 'libghostty_vt_available',
          status: 'skip',
          message: 'native missing',
        },
        {
          name: 'playwright_available',
          status: 'fail',
          message: 'playwright missing',
        },
        {
          name: 'browser_launch',
          status: 'skip',
          message: 'not attempted',
        },
        {
          name: 'ghostty_web_available',
          status: 'skip',
          message: 'not attempted',
        },
      ],
    });

    expect(getCapability(capabilities, 'snapshot')).toMatchObject({
      name: 'snapshot',
      status: 'unavailable',
      reason: 'semantic renderer unavailable',
    });
    expect(getCapability(capabilities, 'wait')).toMatchObject({
      name: 'wait',
      status: 'degraded',
      reason: 'render waits unavailable',
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

  it('marks full browser-backed capabilities unknown when renderer checks are incomplete', async () => {
    const probePlaywright = vi.fn(() => Promise.resolve({ available: true }));

    const capabilities = await discoverCapabilities('full', {
      probePlaywright,
      rendererChecks: [
        {
          name: 'playwright_available',
          status: 'pass',
          message: 'available',
        },
      ],
    });

    expect(probePlaywright).not.toHaveBeenCalled();
    expect(getCapability(capabilities, 'screenshot')).toEqual({
      name: 'screenshot',
      status: 'unknown',
      reason: 'renderer checks incomplete',
      detail: 'doctor did not provide the full renderer check set',
    });
    expect(getCapability(capabilities, 'record-export-webm')).toEqual({
      name: 'record-export-webm',
      status: 'unknown',
      reason: 'renderer checks incomplete',
      detail: 'doctor did not provide the full renderer check set',
    });
    expect(getCapability(capabilities, 'dashboard')).toEqual({
      name: 'dashboard',
      status: 'unknown',
      reason: 'renderer checks incomplete',
      detail: 'doctor did not provide the full renderer check set',
    });
  });

  it('derives the full dashboard capability from the libghostty_vt_available check', async () => {
    const available = await discoverCapabilities('full', {
      rendererChecks: [
        { name: 'libghostty_vt_available', status: 'pass', message: 'ok' },
      ],
    });
    expect(getCapability(available, 'dashboard')).toMatchObject({
      name: 'dashboard',
      status: 'available',
    });

    const missing = await discoverCapabilities('full', {
      rendererChecks: [
        {
          name: 'libghostty_vt_available',
          status: 'skip',
          message: 'libghostty-vt optional renderer not installed',
        },
      ],
    });
    expect(getCapability(missing, 'dashboard')).toEqual({
      name: 'dashboard',
      status: 'unavailable',
      reason: 'libghostty-vt unavailable',
      detail: 'libghostty-vt optional renderer not installed',
    });
  });
});
