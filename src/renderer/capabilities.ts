import assert from 'node:assert/strict';

import { z } from 'zod';

import { ensurePlaywrightBrowsersPath } from './browserPath.js';

// --- Capability vocabulary ---

export const CapabilityNameSchema = z.enum([
  'snapshot',
  'wait',
  'screenshot',
  'record-export-asciicast',
  'record-export-webm',
]);
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

export const CapabilityStatusSchema = z.enum([
  'available',
  'unavailable',
  'degraded',
  'unknown',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityEntrySchema = z
  .object({
    name: CapabilityNameSchema,
    status: CapabilityStatusSchema,
    reason: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

// --- Renderer runtime summary (for inspect) ---

export const RendererRuntimeModeSchema = z.enum([
  'live-host',
  'offline-replay',
]);
export type RendererRuntimeMode = z.infer<typeof RendererRuntimeModeSchema>;

export const RendererRuntimeStatusSchema = z.enum([
  'healthy',
  'fallback',
  'unavailable',
]);
export type RendererRuntimeStatus = z.infer<typeof RendererRuntimeStatusSchema>;

export const RendererRuntimeSummarySchema = z
  .object({
    backend: z.string(),
    mode: RendererRuntimeModeSchema,
    status: RendererRuntimeStatusSchema,
    reason: z.string().optional(),
    // `profile`, `booted`, and `bootInFlight` are only populated when
    // `mode === 'live-host'` and the host has reached the inspect RPC
    // handler. All three stay absent in offline-replay mode and when the
    // host runs an older protocol version that does not surface them.
    // `min(1)` matches the producer-side `HostInspectResultSchema`.
    profile: z.string().min(1).optional(),
    booted: z.boolean().optional(),
    bootInFlight: z.boolean().optional(),
  })
  .strict();
export type RendererRuntimeSummary = z.infer<
  typeof RendererRuntimeSummarySchema
>;

// --- Discovery modes ---

const CAPABILITY_NAMES: ReadonlyArray<CapabilityName> = Object.freeze([
  'snapshot',
  'wait',
  'screenshot',
  'record-export-asciicast',
  'record-export-webm',
]);
const BUILTIN_CAPABILITY_NAMES: ReadonlyArray<CapabilityName> = Object.freeze([
  'snapshot',
  'wait',
  'record-export-asciicast',
]);

type DiscoveryCheckStatus = 'pass' | 'fail' | 'skip';

interface DiscoveryCheck {
  name: string;
  status: DiscoveryCheckStatus;
  message: string;
}

interface PlaywrightProbeResult {
  available: boolean;
  reason?: string;
  detail?: string;
}

export interface CapabilityDiscoveryDependencies {
  probePlaywright?: (mode: DiscoveryMode) => Promise<PlaywrightProbeResult>;
  rendererChecks?: ReadonlyArray<DiscoveryCheck>;
}

export type DiscoveryMode = 'quick' | 'full';

function formatCapabilityError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function probePlaywrightAvailability(
  mode: DiscoveryMode,
): Promise<PlaywrightProbeResult> {
  try {
    // Set PLAYWRIGHT_BROWSERS_PATH in process.env so downstream Playwright calls
    // find the browser cache even when HOME has been changed for isolation.
    ensurePlaywrightBrowsersPath();

    const playwrightModule = (await import('playwright')) as {
      chromium?: {
        launch?: unknown;
      };
    };

    if (mode === 'full') {
      assert.equal(
        typeof playwrightModule.chromium?.launch,
        'function',
        'playwright chromium.launch must be a function',
      );
      return {
        available: true,
        reason: 'playwright import succeeded',
        detail: 'chromium launcher is available for browser-backed rendering',
      };
    }

    return { available: true };
  } catch (error) {
    const detail = formatCapabilityError(error);
    return mode === 'full'
      ? {
          available: false,
          reason: 'playwright import failed',
          detail,
        }
      : {
          available: false,
          reason: 'playwright not installed',
          detail,
        };
  }
}

/**
 * Built-in capabilities (snapshot, wait, record-export-asciicast) are always
 * reported as 'available' because they depend only on the event log and
 * built-in text processing; no external renderer or browser is needed.
 *
 * This reflects runtime feature availability, not guaranteed success for any
 * particular session. Corrupted session data or an invalid event log will fail
 * at invocation time rather than degrading capability discovery.
 */
function buildBuiltinCapability(
  name: CapabilityName,
  mode: DiscoveryMode,
): CapabilityEntry {
  return mode === 'full'
    ? {
        name,
        status: 'available',
        reason: 'built-in capability',
        detail: 'available without external renderer dependencies',
      }
    : {
        name,
        status: 'available',
      };
}

function findRendererCheck(
  checks: ReadonlyArray<DiscoveryCheck>,
  name: string,
): DiscoveryCheck | undefined {
  return checks.find((check) => check.name === name);
}

function buildAvailableDetail(
  checks: ReadonlyArray<DiscoveryCheck>,
): string | undefined {
  if (checks.length === 0) {
    return undefined;
  }

  return checks.map((check) => `${check.name}: ${check.message}`).join('; ');
}

function buildUnknownCapability(name: CapabilityName): CapabilityEntry {
  return {
    name,
    status: 'unknown',
    reason: 'renderer checks incomplete',
    detail: 'doctor did not provide the full renderer check set',
  };
}

function buildFullScreenshotCapabilityFromChecks(
  checks: ReadonlyArray<DiscoveryCheck>,
): CapabilityEntry {
  const playwrightCheck = findRendererCheck(checks, 'playwright_available');
  const browserLaunchCheck = findRendererCheck(checks, 'browser_launch');
  const ghosttyWebCheck = findRendererCheck(checks, 'ghostty_web_available');
  const screenshotCheck = findRendererCheck(checks, 'screenshot_viable');

  if (
    playwrightCheck === undefined ||
    browserLaunchCheck === undefined ||
    ghosttyWebCheck === undefined ||
    screenshotCheck === undefined
  ) {
    return buildUnknownCapability('screenshot');
  }

  if (playwrightCheck.status === 'fail') {
    return {
      name: 'screenshot',
      status: 'unavailable',
      reason: 'playwright unavailable',
      detail: playwrightCheck.message,
    };
  }

  if (ghosttyWebCheck.status === 'fail') {
    return {
      name: 'screenshot',
      status: 'unavailable',
      reason: 'ghostty-web unavailable',
      detail: ghosttyWebCheck.message,
    };
  }

  if (browserLaunchCheck.status === 'fail') {
    return {
      name: 'screenshot',
      status: 'degraded',
      reason: 'browser launch failed',
      detail: browserLaunchCheck.message,
    };
  }

  if (screenshotCheck.status === 'fail') {
    return {
      name: 'screenshot',
      status: 'degraded',
      reason: 'screenshot smoke test failed',
      detail: screenshotCheck.message,
    };
  }

  return {
    name: 'screenshot',
    status: 'available',
    reason: 'renderer smoke checks passed',
    detail: buildAvailableDetail([
      playwrightCheck,
      browserLaunchCheck,
      ghosttyWebCheck,
      screenshotCheck,
    ]),
  };
}

function buildFullWebmCapabilityFromChecks(
  checks: ReadonlyArray<DiscoveryCheck>,
): CapabilityEntry {
  const playwrightCheck = findRendererCheck(checks, 'playwright_available');
  const browserLaunchCheck = findRendererCheck(checks, 'browser_launch');
  const ghosttyWebCheck = findRendererCheck(checks, 'ghostty_web_available');

  if (
    playwrightCheck === undefined ||
    browserLaunchCheck === undefined ||
    ghosttyWebCheck === undefined
  ) {
    return buildUnknownCapability('record-export-webm');
  }

  if (playwrightCheck.status === 'fail') {
    return {
      name: 'record-export-webm',
      status: 'unavailable',
      reason: 'playwright unavailable',
      detail: playwrightCheck.message,
    };
  }

  if (ghosttyWebCheck.status === 'fail') {
    return {
      name: 'record-export-webm',
      status: 'unavailable',
      reason: 'ghostty-web unavailable',
      detail: ghosttyWebCheck.message,
    };
  }

  if (browserLaunchCheck.status === 'fail') {
    return {
      name: 'record-export-webm',
      status: 'degraded',
      reason: 'browser launch failed',
      detail: browserLaunchCheck.message,
    };
  }

  return {
    name: 'record-export-webm',
    status: 'available',
    reason: 'browser-backed export dependencies available',
    detail: buildAvailableDetail([
      playwrightCheck,
      browserLaunchCheck,
      ghosttyWebCheck,
    ]),
  };
}

async function buildPlaywrightCapability(
  name: 'screenshot' | 'record-export-webm',
  mode: DiscoveryMode,
  deps: CapabilityDiscoveryDependencies,
): Promise<CapabilityEntry> {
  if (mode === 'full' && deps.rendererChecks !== undefined) {
    return name === 'screenshot'
      ? buildFullScreenshotCapabilityFromChecks(deps.rendererChecks)
      : buildFullWebmCapabilityFromChecks(deps.rendererChecks);
  }

  const probePlaywright = deps.probePlaywright ?? probePlaywrightAvailability;
  const probe = await probePlaywright(mode);

  return probe.available
    ? mode === 'full'
      ? {
          name,
          status: 'available',
          reason: probe.reason,
          detail: probe.detail,
        }
      : {
          name,
          status: 'available',
        }
    : {
        name,
        status: 'unavailable',
        reason: probe.reason,
        detail: probe.detail,
      };
}

function validateDiscoveredCapabilities(
  capabilities: ReadonlyArray<CapabilityEntry>,
): CapabilityEntry[] {
  const actualNames = capabilities.map((capability) => capability.name);
  const expectedNames = [...CAPABILITY_NAMES];
  assert.equal(
    capabilities.length,
    CAPABILITY_NAMES.length,
    `discovered capabilities must include every known capability exactly once (got [${actualNames.join(', ')}], expected [${expectedNames.join(', ')}])`,
  );

  const duplicateNames = actualNames.filter(
    (name, index) => actualNames.indexOf(name) !== index,
  );
  assert.equal(
    new Set(actualNames).size,
    CAPABILITY_NAMES.length,
    `discovered capabilities must not contain duplicates (got [${actualNames.join(', ')}], expected [${expectedNames.join(', ')}], duplicates [${duplicateNames.join(', ')}])`,
  );

  return capabilities.map((capability) =>
    CapabilityEntrySchema.parse(capability),
  );
}

/**
 * Discover runtime capabilities.
 *
 * - 'quick' mode: fast checks suitable for `version --json` (no browser launch).
 * - 'full' mode: deeper probing suitable for `doctor --json`.
 */
export async function discoverCapabilities(
  mode: DiscoveryMode,
  deps: CapabilityDiscoveryDependencies = {},
): Promise<CapabilityEntry[]> {
  const capabilities: CapabilityEntry[] = [];

  for (const name of BUILTIN_CAPABILITY_NAMES) {
    capabilities.push(buildBuiltinCapability(name, mode));
  }

  capabilities.push(await buildPlaywrightCapability('screenshot', mode, deps));
  capabilities.push(
    await buildPlaywrightCapability('record-export-webm', mode, deps),
  );

  const sortedCapabilities: CapabilityEntry[] = [];
  for (const name of CAPABILITY_NAMES) {
    const capability = capabilities.find((entry) => entry.name === name);
    if (capability === undefined) {
      throw new Error(`missing discovered capability entry for ${name}`);
    }
    sortedCapabilities.push(capability);
  }

  return validateDiscoveredCapabilities(sortedCapabilities);
}
