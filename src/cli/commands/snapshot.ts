import type {
  SnapshotParams,
  SnapshotResult,
} from '../../protocol/messages.js';
import type { SemanticSnapshot } from '../../renderer/types.js';

import { CliError } from '../../cli/errors.js';
import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { SnapshotParamsSchema } from '../../protocol/messages.js';
import { SnapshotResultSchema } from '../../protocol/schemas.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { withOfflineReplayRenderer } from '../../replay/offlineReplay.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../../storage/artifactManifest.js';
import {
  readManifestIfExists,
  writeTextFileAtomic,
} from '../../storage/manifests.js';
import {
  artifactPath,
  ensureArtifactsDir,
  snapshotFilename,
} from '../../storage/artifactPaths.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const DEFAULT_SNAPSHOT_FORMAT = 'structured';

type SnapshotFormat = NonNullable<SnapshotParams['format']>;

interface CommandOptions {
  context: CommandContext;
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

function parseSnapshotResult(rawResult: unknown): SnapshotResult {
  const parsedResult = SnapshotResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }

  return parsedResult.data;
}

function createSnapshotResult(
  snapshot: SemanticSnapshot,
  format: SnapshotFormat,
): SnapshotResult {
  const snapshotResult: SnapshotResult =
    format === 'structured'
      ? { format: 'structured' as const, ...snapshot }
      : {
          format: 'text' as const,
          sessionId: snapshot.sessionId,
          capturedAtSeq: snapshot.capturedAtSeq,
          cols: snapshot.cols,
          rows: snapshot.rows,
          cursorRow: snapshot.cursorRow,
          cursorCol: snapshot.cursorCol,
          text: snapshot.visibleLines.map((line) => line.text).join('\n'),
        };

  return parseSnapshotResult(snapshotResult);
}

async function persistSnapshotArtifact(
  sessionDirectory: string,
  format: SnapshotFormat,
  snapshot: SemanticSnapshot,
  snapshotResult: SnapshotResult,
): Promise<void> {
  await ensureArtifactsDir(sessionDirectory);
  const filename = snapshotFilename(snapshot.capturedAtSeq, format);
  const snapshotArtifactPath = artifactPath(sessionDirectory, filename);

  await writeTextFileAtomic({
    path: snapshotArtifactPath,
    pathLabel: 'snapshot artifact path',
    contents: `${JSON.stringify(snapshotResult, null, 2)}\n`,
    writeErrorMessage: `Failed to write snapshot artifact at ${snapshotArtifactPath}.`,
  });

  await appendArtifact(
    sessionDirectory,
    createArtifactEntry({
      kind: 'snapshot',
      filename,
      sessionId: snapshot.sessionId,
      capturedAtSeq: snapshot.capturedAtSeq,
      metadata: {
        format,
        cols: snapshot.cols,
        rows: snapshot.rows,
        cursorRow: snapshot.cursorRow,
        cursorCol: snapshot.cursorCol,
      },
    }),
  );
}

async function runRpcSnapshot(
  sessionDirectory: string,
  format: SnapshotFormat,
): Promise<SnapshotResult> {
  const rawResult: unknown = await sendRpc(
    socketPath(sessionDirectory),
    'snapshot',
    {
      format,
    },
  );

  return parseSnapshotResult(rawResult);
}

async function runOfflineSnapshot(
  sessionDirectory: string,
  format: SnapshotFormat,
): Promise<SnapshotResult> {
  return withOfflineReplayRenderer(
    { sessionDir: sessionDirectory },
    async ({ backend }) => {
      const snapshot: SemanticSnapshot = await backend.snapshot();
      const snapshotResult = createSnapshotResult(snapshot, format);
      await persistSnapshotArtifact(
        sessionDirectory,
        format,
        snapshot,
        snapshotResult,
      );
      return snapshotResult;
    },
  );
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
  const home = options.context.home;
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

  let result: SnapshotResult;
  if (manifest.status === 'running') {
    try {
      result = await runRpcSnapshot(sessionDirectory, format);
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === ERROR_CODES.HOST_UNREACHABLE
      ) {
        result = await runOfflineSnapshot(sessionDirectory, format);
      } else {
        throw error;
      }
    }
  } else {
    result = await runOfflineSnapshot(sessionDirectory, format);
  }

  emitSuccess({
    command: 'snapshot',
    json: options.json,
    result,
    lines: formatSnapshotLines(result),
  });
}
