import {
  HostInspectResultSchema,
  type ArtifactHealthSummary,
  type InspectResult,
  type RendererRuntimeSummary,
} from '../../protocol/messages.js';
import type { SessionRecord, SessionStatus } from '../../protocol/schemas.js';

import { CliError } from '../errors.js';
import type { CommandContext } from '../context.js';

import { countEventLogEntries } from '../../host/eventLog.js';
import { reconcileSession } from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
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
  const endAt =
    session.status === 'running' ? Date.now() : Date.parse(session.updatedAt);

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

function usesOfflineReplay(sessionStatus: SessionStatus): boolean {
  return (
    sessionStatus === 'exited' ||
    sessionStatus === 'failed' ||
    sessionStatus === 'destroyed'
  );
}

function deriveRendererRuntimeSummary(options: {
  usedOfflineReplay: boolean;
  sessionStatus: SessionStatus;
}): RendererRuntimeSummary {
  if (options.usedOfflineReplay) {
    return {
      backend: RENDERER_BACKEND,
      mode: 'offline-replay',
      status: 'fallback',
      reason: 'host-unreachable',
    };
  }

  if (usesOfflineReplay(options.sessionStatus)) {
    return {
      backend: RENDERER_BACKEND,
      mode: 'offline-replay',
      status: 'fallback',
      reason: 'session-not-running',
    };
  }

  return {
    backend: RENDERER_BACKEND,
    mode: 'live-host',
    status: 'healthy',
  };
}

function formatRendererRuntime(summary: RendererRuntimeSummary): string {
  const reasonSuffix =
    summary.reason === undefined ? '' : ` — ${summary.reason}`;

  return `${summary.backend} (${summary.mode}, ${summary.status}${reasonSuffix})`;
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

  if (rendererRuntime !== undefined) {
    lines.push(`Renderer: ${formatRendererRuntime(rendererRuntime)}`);
  }

  if (result.lastEventSeq !== undefined) {
    lines.push(`Last Event Seq: ${String(result.lastEventSeq)}`);
  }

  lines.push(`Uptime: ${String(uptime)}ms`);

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
    session.status !== 'running' &&
    session.status !== 'exiting' &&
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

  const isOffline = usesOfflineReplay(session.status);
  if (!isOffline) {
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
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === ERROR_CODES.HOST_UNREACHABLE
      ) {
        await reconcileSession(sessionDirectory);
        session = await readManifest(manifestFile);
        usedOfflineReplay = true;
      } else {
        throw error;
      }
    }
  }

  const eventCount = await countEventLogEntries(eventLogPath(sessionDirectory));
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
  });
  const result: InspectResult = {
    session,
    eventCount,
    uptime,
    lastEventSeq: eventCount > 0 ? eventCount - 1 : undefined,
    terminationCategory,
    artifacts,
    usedOfflineReplay,
    rendererRuntime,
  };

  emitSuccess({
    command: 'inspect',
    json: options.json,
    result,
    lines: formatSessionLines(result),
  });
}
