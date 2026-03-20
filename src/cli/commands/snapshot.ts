import type { SnapshotResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import {
  SnapshotParamsSchema,
  type SnapshotParams,
} from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { resolveHome } from '../../storage/home.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const DEFAULT_SNAPSHOT_FORMAT = 'structured';

type SnapshotFormat = NonNullable<SnapshotParams['format']>;

interface CommandOptions {
  json: boolean;
  sessionId: string;
  format?: string;
}

function resolveSnapshotFormat(format: string | undefined): SnapshotFormat {
  const effectiveFormat = format ?? DEFAULT_SNAPSHOT_FORMAT;
  const formatResult = SnapshotParamsSchema.safeParse({
    format: effectiveFormat,
  });

  if (!formatResult.success) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Snapshot format must be one of: structured, text.',
      details: {
        format: effectiveFormat,
      },
      cause: formatResult.error,
    });
  }

  if (formatResult.data.format === undefined) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Snapshot format is required.',
      details: {
        format: effectiveFormat,
      },
    });
  }

  return formatResult.data.format;
}

function formatSnapshotLines(result: SnapshotResult): string[] {
  const lines = [
    `Session ID: ${result.sessionId}`,
    `Captured At Seq: ${String(result.capturedAtSeq)}`,
    `Format: ${result.format}`,
    `Size: ${String(result.cols)}x${String(result.rows)}`,
    `Cursor: row ${String(result.cursorRow)}, col ${String(result.cursorCol)}`,
  ];

  if (result.format === 'structured') {
    lines.push(`Alt Screen: ${result.isAltScreen ? 'yes' : 'no'}`);

    if (result.visibleLines.length === 0) {
      lines.push('Visible Lines: (none)');
      return lines;
    }

    lines.push(`Visible Lines (${String(result.visibleLines.length)}):`);
    for (const line of result.visibleLines) {
      lines.push(`  [${String(line.row)}] ${line.text}`);
    }

    return lines;
  }

  lines.push('Text:');
  lines.push(result.text.length > 0 ? result.text : '(empty)');
  return lines;
}

export async function runSnapshotCommand(
  options: CommandOptions,
): Promise<void> {
  const format = resolveSnapshotFormat(options.format);
  const home = resolveHome();
  let sessionDirectory: string;

  try {
    sessionDirectory = sessionDir(home, options.sessionId);
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_SESSION_ID, {
      message: `Session ID "${options.sessionId}" is invalid.`,
      details: {
        sessionId: options.sessionId,
      },
      cause: error,
    });
  }

  const manifestFile = manifestPath(sessionDirectory);
  const manifest = await readManifestIfExists(manifestFile);

  if (manifest === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${options.sessionId}" was not found.`,
      details: {
        sessionId: options.sessionId,
        manifestPath: manifestFile,
      },
    });
  }

  if (manifest.status !== 'running') {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  const result = (await sendRpc(socketPath(sessionDirectory), 'snapshot', {
    format,
  })) as SnapshotResult;

  emitSuccess({
    command: 'snapshot',
    json: options.json,
    result,
    lines: formatSnapshotLines(result),
  });
}
