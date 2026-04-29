import type { SnapshotResult } from '../../protocol/messages.js';
import type { SnapshotFormat } from '../../snapshot/capture.js';
import type { SemanticSnapshot } from '../../renderer/types.js';

import { CliError } from '../../cli/errors.js';
import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { SnapshotParamsSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { withOfflineReplayRenderer } from '../../replay/offlineReplay.js';
import {
  captureSnapshotResult,
  parseSnapshotResult,
} from '../../snapshot/capture.js';
import { invariant } from '../../util/assert.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const DEFAULT_SNAPSHOT_FORMAT = 'structured';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  format?: string;
  includeScrollback?: boolean;
  includeCells?: boolean;
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

function resolveIncludeScrollback(
  includeScrollback: boolean | undefined,
): boolean {
  const effectiveIncludeScrollback = includeScrollback ?? false;
  invariant(
    typeof effectiveIncludeScrollback === 'boolean',
    'includeScrollback must be boolean',
  );
  return effectiveIncludeScrollback;
}

function resolveIncludeCells(includeCells: boolean | undefined): boolean {
  const effectiveIncludeCells = includeCells ?? false;
  invariant(
    typeof effectiveIncludeCells === 'boolean',
    'includeCells must be boolean',
  );
  return effectiveIncludeCells;
}

async function runRpcSnapshot(
  sessionDirectory: string,
  rendererName: CommandContext['rendererDefault'],
  format: SnapshotFormat,
  includeScrollback: boolean,
  includeCells: boolean,
): Promise<SnapshotResult> {
  const rawResult: unknown = await sendRpc(
    socketPath(sessionDirectory),
    'snapshot',
    {
      format,
      includeScrollback,
      includeCells,
      rendererName,
    },
  );

  return parseSnapshotResult(rawResult);
}

async function runOfflineSnapshot(
  sessionDirectory: string,
  rendererName: CommandContext['rendererDefault'],
  format: SnapshotFormat,
  includeScrollback: boolean,
  includeCells: boolean,
): Promise<SnapshotResult> {
  return withOfflineReplayRenderer(
    { sessionDir: sessionDirectory, rendererName },
    async ({ backend, manifest }) => {
      const snapshot: SemanticSnapshot = await backend.snapshot({
        includeScrollback,
        includeCells,
      });
      return await captureSnapshotResult({
        sessionDir: sessionDirectory,
        format,
        snapshot,
        rendererBackend: backend.rendererBackend,
        expectedSessionId: manifest.sessionId,
      });
    },
  );
}

function appendSnapshotLineBlock(
  lines: string[],
  label: string,
  snapshotLines: SemanticSnapshot['visibleLines'],
): void {
  lines.push(`${label} (${String(snapshotLines.length)}):`);
  if (snapshotLines.length === 0) {
    lines.push('  (none)');
    return;
  }

  for (const line of snapshotLines) {
    lines.push(`  [${String(line.row)}] ${line.text}`);
  }
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

    if (result.scrollbackLines !== undefined) {
      appendSnapshotLineBlock(
        lines,
        'Scrollback Lines',
        result.scrollbackLines,
      );
      appendSnapshotLineBlock(lines, 'Visible Lines', result.visibleLines);
      return lines;
    }

    if (result.visibleLines.length === 0) {
      lines.push('Visible Lines: (none)');
      return lines;
    }

    appendSnapshotLineBlock(lines, 'Visible Lines', result.visibleLines);
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
  const includeScrollback = resolveIncludeScrollback(options.includeScrollback);
  const includeCells = resolveIncludeCells(options.includeCells);
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
  // Snapshot and screenshot intentionally keep their narrower legacy live-RPC
  // gate. `exiting` sessions are live-host eligible for inspect, but these
  // commands preserve their existing offline-replay capture behavior.
  if (manifest.status === 'running') {
    try {
      result = await runRpcSnapshot(
        sessionDirectory,
        options.context.rendererDefault,
        format,
        includeScrollback,
        includeCells,
      );
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === ERROR_CODES.HOST_UNREACHABLE
      ) {
        result = await runOfflineSnapshot(
          sessionDirectory,
          options.context.rendererDefault,
          format,
          includeScrollback,
          includeCells,
        );
      } else {
        throw error;
      }
    }
  } else {
    result = await runOfflineSnapshot(
      sessionDirectory,
      options.context.rendererDefault,
      format,
      includeScrollback,
      includeCells,
    );
  }

  emitSuccess({
    command: 'snapshot',
    json: options.json,
    result,
    lines: formatSnapshotLines(result),
  });
}
