import {
  HostInspectResultSchema,
  type ArtifactHealthSummary,
  type HostInspectResult,
  type HostInfo,
  type InspectResult,
  type RendererRuntimeSummary,
} from '../../protocol/messages.js';
import type { SessionRecord, SessionStatus } from '../../protocol/schemas.js';

import { CliError } from '../errors.js';
import type { CommandContext } from '../context.js';

import {
  countEventLogEntries,
  statEventLogBytes,
} from '../../host/eventLog.js';
import { reconcileSession } from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
import {
  isCommandableSessionStatus,
  isLiveHostEligibleSessionStatus,
  isOfflineReplayEligibleSessionStatus,
} from '../../protocol/sessionStatusPolicy.js';
import { deriveTerminationCategory } from '../../protocol/terminationCategory.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { emitSuccess } from '../output.js';
import { computeArtifactHealth } from '../../storage/artifactHealth.js';
import { readManifest, readManifestIfExists } from '../../storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
}

function computeUptime(session: SessionRecord): number {
  const createdAt = Date.parse(session.createdAt);
  // Matches pre-existing behavior: only running sessions show live uptime.
  const endAt = isCommandableSessionStatus(session.status)
    ? Date.now()
    : Date.parse(session.updatedAt);

  return Math.max(0, endAt - createdAt);
}

function formatArtifactKinds(byKind: Record<string, number>): string {
  const kindEntries = Object.entries(byKind).sort(([leftKind], [rightKind]) =>
    leftKind.localeCompare(rightKind),
  );

  if (kindEntries.length === 0) {
    return 'none';
  }

  return kindEntries
    .map(([kind, count]) => `${kind}: ${String(count)}`)
    .join(', ');
}

const RENDERER_BACKEND = 'ghostty-web';

function deriveRendererRuntimeSummary(options: {
  usedOfflineReplay: boolean;
  sessionStatus: SessionStatus;
  hostInfo?: HostInspectResult;
}): RendererRuntimeSummary {
  if (options.usedOfflineReplay) {
    return {
      backend: RENDERER_BACKEND,
      mode: 'offline-replay',
      status: 'fallback',
      reason: 'host-unreachable',
    };
  }

  if (isOfflineReplayEligibleSessionStatus(options.sessionStatus)) {
    return {
      backend: RENDERER_BACKEND,
      mode: 'offline-replay',
      status: 'fallback',
      reason: 'session-not-running',
    };
  }

  const hostInfo = options.hostInfo;
  return {
    backend: RENDERER_BACKEND,
    mode: 'live-host',
    status: 'healthy',
    ...(hostInfo?.rendererProfile !== undefined
      ? { profile: hostInfo.rendererProfile }
      : {}),
    ...(hostInfo?.rendererBooted !== undefined
      ? { booted: hostInfo.rendererBooted }
      : {}),
    ...(hostInfo?.rendererBootInFlight !== undefined
      ? { bootInFlight: hostInfo.rendererBootInFlight }
      : {}),
  };
}

function formatRendererRuntime(summary: RendererRuntimeSummary): string {
  const reasonSuffix =
    summary.reason === undefined ? '' : ` — ${summary.reason}`;
  const extras: string[] = [];
  if (summary.profile !== undefined) {
    extras.push(`profile: ${summary.profile}`);
  }
  if (summary.booted !== undefined) {
    extras.push(`booted: ${summary.booted ? 'yes' : 'no'}`);
  }
  if (summary.bootInFlight === true) {
    extras.push('boot-in-flight');
  }
  const extrasSuffix = extras.length > 0 ? ` [${extras.join(', ')}]` : '';

  return `${summary.backend} (${summary.mode}, ${summary.status}${reasonSuffix})${extrasSuffix}`;
}

function formatSessionLines(result: InspectResult): string[] {
  const { session, eventCount, rendererRuntime, uptime } = result;
  const lines = [
    `Session ID: ${session.sessionId}`,
    `Status: ${session.status}`,
    `Command: ${session.command.join(' ')}`,
    `Working Directory: ${session.cwd}`,
    `Size: ${String(session.cols)}x${String(session.rows)}`,
    `Created At: ${session.createdAt}`,
    `Updated At: ${session.updatedAt}`,
    `Event Count: ${String(eventCount)}`,
  ];

  lines.push(`Renderer: ${formatRendererRuntime(rendererRuntime)}`);

  if (result.lastEventSeq !== undefined) {
    lines.push(`Last Event Seq: ${String(result.lastEventSeq)}`);
  }

  if (result.eventLogBytes !== undefined) {
    lines.push(`Event Log Bytes: ${String(result.eventLogBytes)}`);
  }

  lines.push(`Uptime: ${String(uptime)}ms`);

  if (result.host !== undefined) {
    if (result.host.cliVersion !== undefined) {
      lines.push(`Host CLI Version: ${result.host.cliVersion}`);
    }
    lines.push(`RPC Socket: ${result.host.rpcSocketPath}`);
  }

  if (result.artifacts !== undefined) {
    lines.push(
      `Artifacts: ${String(result.artifacts.total)} total (${formatArtifactKinds(result.artifacts.byKind)}), health: ${result.artifacts.health}`,
    );
  }

  if (result.usedOfflineReplay === true) {
    lines.push('Offline Replay: yes');
  }

  lines.push(
    `Host PID: ${String(session.hostPid ?? '-')}`,
    `Child PID: ${String(session.childPid ?? '-')}`,
    `Exit Code: ${String(session.exitCode ?? '-')}`,
    `Exit Signal: ${session.exitSignal ?? '-'}`,
  );

  if (
    !isLiveHostEligibleSessionStatus(session.status) &&
    result.terminationCategory !== undefined
  ) {
    lines.push(`Termination: ${result.terminationCategory}`);
  }

  if (session.failureReason !== undefined) {
    lines.push(`Failure Reason: ${session.failureReason}`);
  }
  if (session.failureOrigin !== undefined) {
    lines.push(`Failure Origin: ${session.failureOrigin}`);
  }
  return lines;
}

export async function runInspectCommand(
  options: CommandOptions,
): Promise<void> {
  const home = options.context.home;
  const sessionDirectory = sessionDir(home, options.sessionId);
  const manifestFile = manifestPath(sessionDirectory);
  let session = await readManifestIfExists(manifestFile);
  let usedOfflineReplay = false;

  if (session === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${options.sessionId}" was not found.`,
      details: {
        sessionId: options.sessionId,
        manifestPath: manifestFile,
      },
    });
  }

  const isLiveHostEligible = isLiveHostEligibleSessionStatus(session.status);
  let hostInfo: HostInspectResult | undefined;
  if (isLiveHostEligible) {
    try {
      const rawResult: unknown = await sendRpc(
        socketPath(sessionDirectory),
        'inspect',
      );
      const parsedResult = HostInspectResultSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
          message: 'Unexpected response from host',
          details: { issues: parsedResult.error.issues },
        });
      }
      session = parsedResult.data.session;
      hostInfo = parsedResult.data;
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === ERROR_CODES.HOST_UNREACHABLE
      ) {
        await reconcileSession(sessionDirectory);
        session = await readManifest(manifestFile);
        usedOfflineReplay = true;
        hostInfo = undefined;
      } else {
        throw error;
      }
    }
  }

  const eventLogFile = eventLogPath(sessionDirectory);
  const eventCount = await countEventLogEntries(eventLogFile);
  const eventLogBytes = await statEventLogBytes(eventLogFile);
  const uptime = computeUptime(session);
  let artifacts: ArtifactHealthSummary | undefined;
  try {
    artifacts = await computeArtifactHealth(sessionDirectory);
  } catch {
    // Artifact health is best-effort; do not fail the entire inspect
    // command if the artifact manifest or files are inaccessible.
    artifacts = undefined;
  }
  const terminationCategory = deriveTerminationCategory(session);
  const rendererRuntime = deriveRendererRuntimeSummary({
    usedOfflineReplay,
    sessionStatus: session.status,
    ...(hostInfo !== undefined ? { hostInfo } : {}),
  });
  const host: HostInfo | undefined =
    hostInfo !== undefined && hostInfo.rpcSocketPath !== undefined
      ? {
          ...(hostInfo.cliVersion !== undefined
            ? { cliVersion: hostInfo.cliVersion }
            : {}),
          rpcSocketPath: hostInfo.rpcSocketPath,
        }
      : undefined;
  const result: InspectResult = {
    session,
    eventCount,
    uptime,
    lastEventSeq: eventCount > 0 ? eventCount - 1 : undefined,
    terminationCategory,
    artifacts,
    usedOfflineReplay,
    rendererRuntime,
    ...(host !== undefined ? { host } : {}),
    ...(eventLogBytes !== undefined ? { eventLogBytes } : {}),
  };

  emitSuccess({
    command: 'inspect',
    json: options.json,
    result,
    lines: formatSessionLines(result),
  });
}
