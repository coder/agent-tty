import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import type { CliError } from '../cli/errors.js';
import type { CapabilityEntry, DiscoveryMode } from './capabilities.js';

/**
 * Readiness of the in-process `libghostty-vt` renderer that the
 * **Session Dashboard** requires. The dashboard always uses this backend and
 * never falls back to the browser-backed renderer (ADR 0006), so it must fail
 * fast with an actionable message when the optional native dependency is
 * absent, and `doctor` must report the resulting `dashboard` capability.
 */
export const LIBGHOSTTY_VT_PACKAGE = '@coder/libghostty-vt-node';

export const DASHBOARD_RENDERER_UNAVAILABLE_MESSAGE =
  `The dashboard requires the in-process libghostty-vt renderer, provided by the optional dependency ${LIBGHOSTTY_VT_PACKAGE}. ` +
  'Reinstall agent-tty on a supported platform so the optional native package is fetched, then run `agent-tty doctor` to confirm readiness.';

export interface LibghosttyVtProbe {
  available: boolean;
  reason?: string;
  detail?: string;
}

export type LibghosttyVtLoader = () => Promise<unknown>;

function defaultLoader(): Promise<unknown> {
  return import('@coder/libghostty-vt-node');
}

/**
 * Probe whether `libghostty-vt` can render: the optional native package must
 * load and expose `createTerminal()` (the same shape the backend boots from).
 */
export async function probeLibghosttyVt(
  loader: LibghosttyVtLoader = defaultLoader,
): Promise<LibghosttyVtProbe> {
  try {
    const module = (await loader()) as { createTerminal?: unknown };
    if (typeof module.createTerminal !== 'function') {
      return {
        available: false,
        reason: 'libghostty-vt module is incomplete',
        detail: `${LIBGHOSTTY_VT_PACKAGE} loaded but did not expose createTerminal()`,
      };
    }
    return {
      available: true,
      reason: 'libghostty-vt native module available',
      detail: `${LIBGHOSTTY_VT_PACKAGE} exposes createTerminal()`,
    };
  } catch (error) {
    return {
      available: false,
      reason: 'libghostty-vt not installed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Throw an actionable CLI error when the dashboard renderer is unavailable. */
export function assertDashboardRendererAvailable(
  probe: LibghosttyVtProbe,
): void {
  if (probe.available) {
    return;
  }
  throw makeCliError(ERROR_CODES.INVALID_INPUT, {
    message: DASHBOARD_RENDERER_UNAVAILABLE_MESSAGE,
    details: {
      renderer: 'libghostty-vt',
      ...(probe.detail === undefined ? {} : { detail: probe.detail }),
    },
  }) satisfies CliError;
}

/** Build the `dashboard` capability entry that `doctor`/`version` report. */
export function buildDashboardCapability(
  probe: LibghosttyVtProbe,
  mode: DiscoveryMode,
): CapabilityEntry {
  if (!probe.available) {
    return {
      name: 'dashboard',
      status: 'unavailable',
      ...(probe.reason === undefined ? {} : { reason: probe.reason }),
      ...(probe.detail === undefined ? {} : { detail: probe.detail }),
    };
  }
  return mode === 'full'
    ? {
        name: 'dashboard',
        status: 'available',
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
      }
    : { name: 'dashboard', status: 'available' };
}
