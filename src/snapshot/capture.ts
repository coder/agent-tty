import type { SnapshotParams, SnapshotResult } from '../protocol/messages.js';
import type { SemanticSnapshot } from '../renderer/types.js';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { SnapshotResultSchema } from '../protocol/schemas.js';
import { parseValidatedResult } from '../protocol/validation.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  snapshotFilename,
} from '../storage/artifactPaths.js';
import { writeTextFileAtomic } from '../storage/manifests.js';
import { invariant } from '../util/assert.js';

export type SnapshotFormat = NonNullable<SnapshotParams['format']>;

export function parseSnapshotResult(
  rawResult: unknown,
  message = 'Unexpected response from host',
): SnapshotResult {
  return parseValidatedResult(SnapshotResultSchema, rawResult, message);
}

export function createSnapshotResult(
  snapshot: SemanticSnapshot,
  format: SnapshotFormat,
): SnapshotResult {
  const textLines = [
    ...(snapshot.scrollbackLines ?? []).map((line) => line.text),
    ...snapshot.visibleLines.map((line) => line.text),
  ];

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
          text: textLines.join('\n'),
        };

  return parseSnapshotResult(
    snapshotResult,
    'Snapshot result validation failed.',
  );
}

export interface PersistSnapshotArtifactOptions {
  sessionDir: string;
  format: SnapshotFormat;
  snapshot: SemanticSnapshot;
  result: SnapshotResult;
  rendererBackend: string;
}

export interface CaptureSnapshotResultOptions {
  sessionDir: string;
  format: SnapshotFormat;
  snapshot: SemanticSnapshot;
  rendererBackend: string;
  expectedSessionId?: string;
}

function assertSnapshotResultMatchesSource(
  format: SnapshotFormat,
  snapshot: SemanticSnapshot,
  result: SnapshotResult,
): void {
  invariant(
    result.format === format,
    'snapshot result format must match format',
  );
  invariant(
    result.sessionId === snapshot.sessionId,
    'snapshot result sessionId must match snapshot sessionId',
  );
  invariant(
    result.capturedAtSeq === snapshot.capturedAtSeq,
    'snapshot result capturedAtSeq must match snapshot capturedAtSeq',
  );
  invariant(
    result.cols === snapshot.cols,
    'snapshot result cols must match snapshot cols',
  );
  invariant(
    result.rows === snapshot.rows,
    'snapshot result rows must match snapshot rows',
  );
  invariant(
    result.cursorRow === snapshot.cursorRow,
    'snapshot result cursorRow must match snapshot cursorRow',
  );
  invariant(
    result.cursorCol === snapshot.cursorCol,
    'snapshot result cursorCol must match snapshot cursorCol',
  );
}

export async function persistSnapshotArtifact(
  options: PersistSnapshotArtifactOptions,
): Promise<void> {
  invariant(options.sessionDir.length > 0, 'sessionDir must be non-empty');
  invariant(
    options.rendererBackend.length > 0,
    'rendererBackend must be a non-empty string',
  );
  assertSnapshotResultMatchesSource(
    options.format,
    options.snapshot,
    options.result,
  );

  await ensureArtifactsDir(options.sessionDir);
  const filename = snapshotFilename(
    options.snapshot.capturedAtSeq,
    options.format,
  );
  const snapshotArtifactPath = artifactPath(options.sessionDir, filename);

  await writeTextFileAtomic({
    path: snapshotArtifactPath,
    pathLabel: 'snapshot artifact path',
    contents: `${JSON.stringify(options.result, null, 2)}\n`,
    writeErrorMessage: `Failed to write snapshot artifact at ${snapshotArtifactPath}.`,
  });

  await appendArtifact(
    options.sessionDir,
    createArtifactEntry({
      kind: 'snapshot',
      filename,
      sessionId: options.snapshot.sessionId,
      capturedAtSeq: options.snapshot.capturedAtSeq,
      metadata: {
        format: options.format,
        rendererBackend: options.rendererBackend,
        cols: options.snapshot.cols,
        rows: options.snapshot.rows,
        cursorRow: options.snapshot.cursorRow,
        cursorCol: options.snapshot.cursorCol,
        ...(options.snapshot.scrollbackLines === undefined
          ? {}
          : { scrollbackLineCount: options.snapshot.scrollbackLines.length }),
      },
    }),
  );
}

export async function captureSnapshotResult(
  options: CaptureSnapshotResultOptions,
): Promise<SnapshotResult> {
  if (options.expectedSessionId !== undefined) {
    const actualSessionId = options.snapshot.sessionId;
    if (actualSessionId !== options.expectedSessionId) {
      throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
        message: 'Snapshot sessionId mismatch.',
        details: {
          expectedSessionId: options.expectedSessionId,
          actualSessionId,
        },
      });
    }
  }

  const result = createSnapshotResult(options.snapshot, options.format);
  await persistSnapshotArtifact({
    sessionDir: options.sessionDir,
    format: options.format,
    snapshot: options.snapshot,
    result,
    rendererBackend: options.rendererBackend,
  });

  return result;
}
