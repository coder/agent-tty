import {
  InspectResultSchema,
  type InspectResult,
} from '../../protocol/messages.js';
import type { SessionRecord } from '../../protocol/schemas.js';

import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';
import { reconcileSession } from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifest, readManifestIfExists } from '../../storage/manifests.js';
import { resolveHome } from '../../storage/home.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

interface CommandOptions {
  json: boolean;
  sessionId: string;
}

function formatSessionLines(session: SessionRecord): string[] {
  return [
    `Session ID: ${session.sessionId}`,
    `Status: ${session.status}`,
    `Command: ${session.command.join(' ')}`,
    `Working Directory: ${session.cwd}`,
    `Size: ${String(session.cols)}x${String(session.rows)}`,
    `Created At: ${session.createdAt}`,
    `Updated At: ${session.updatedAt}`,
    `Host PID: ${String(session.hostPid ?? '-')}`,
    `Child PID: ${String(session.childPid ?? '-')}`,
    `Exit Code: ${String(session.exitCode ?? '-')}`,
    `Exit Signal: ${session.exitSignal ?? '-'}`,
  ];
}

export async function runInspectCommand(
  options: CommandOptions,
): Promise<void> {
  const home = resolveHome();
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

  if (session.status !== 'exited') {
    try {
      const rawResult: unknown = await sendRpc(
        socketPath(sessionDirectory),
        'inspect',
      );
      const parsedResult = InspectResultSchema.safeParse(rawResult);
      if (!parsedResult.success) {
        throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
          message: 'Unexpected response from host',
          details: { issues: parsedResult.error.issues },
        });
      }
      const liveResult: InspectResult = parsedResult.data;
      session = liveResult.session;
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

  emitSuccess({
    command: 'inspect',
    json: options.json,
    result: { session },
    lines: formatSessionLines(session),
  });
}
