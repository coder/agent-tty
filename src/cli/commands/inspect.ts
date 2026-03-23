import {
  HostInspectResultSchema,
  type InspectResult,
} from '../../protocol/messages.js';
import type { SessionRecord } from '../../protocol/schemas.js';

import { CliError } from '../errors.js';
import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { countEventLogEntries } from '../../host/eventLog.js';
import { reconcileSession } from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
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

function formatSessionLines(result: InspectResult): string[] {
  const { session, eventCount, uptime } = result;
  const lines = [
    `Session ID: ${session.sessionId}`,
    `Status: ${session.status}`,
    `Command: ${session.command.join(' ')}`,
    `Working Directory: ${session.cwd}`,
    `Size: ${String(session.cols)}x${String(session.rows)}`,
    `Created At: ${session.createdAt}`,
    `Updated At: ${session.updatedAt}`,
    `Event Count: ${String(eventCount)}`,
    `Uptime: ${String(uptime)}ms`,
    `Host PID: ${String(session.hostPid ?? '-')}`,
    `Child PID: ${String(session.childPid ?? '-')}`,
    `Exit Code: ${String(session.exitCode ?? '-')}`,
    `Exit Signal: ${session.exitSignal ?? '-'}`,
  ];
  if (session.failureReason !== undefined) {
    lines.push(`Failure Reason: ${session.failureReason}`);
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

  if (session === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${options.sessionId}" was not found.`,
      details: {
        sessionId: options.sessionId,
        manifestPath: manifestFile,
      },
    });
  }

  const isOffline =
    session.status === 'exited' ||
    session.status === 'failed' ||
    session.status === 'destroyed';
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
      } else {
        throw error;
      }
    }
  }

  const eventCount = await countEventLogEntries(eventLogPath(sessionDirectory));
  const uptime = computeUptime(session);
  const result: InspectResult = {
    session,
    eventCount,
    uptime,
  };

  emitSuccess({
    command: 'inspect',
    json: options.json,
    result,
    lines: formatSessionLines(result),
  });
}
