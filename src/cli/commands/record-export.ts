import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { emitSuccess } from '../output.js';
import { generateAsciicast } from '../../export/asciicast.js';
import {
  generateWebmExport,
  type WebmExportResult,
} from '../../export/webm.js';
import { readEventLogRecords } from '../../host/replay.js';
import { GhosttyWebBackend } from '../../renderer/ghosttyWeb/backend.js';
import { CliError } from '../errors.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import {
  RecordExportResultSchema,
  type RecordExportResult,
} from '../../protocol/messages.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../../storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  recordingFilename,
} from '../../storage/artifactPaths.js';
import { resolveHome } from '../../storage/home.js';
import {
  readManifestIfExists,
  writeTextFileAtomic,
} from '../../storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
} from '../../storage/sessionPaths.js';
import { invariant } from '../../util/assert.js';

const RecordExportFormatSchema = z.enum(['asciicast', 'webm']);

type RecordExportFormat = z.infer<typeof RecordExportFormatSchema>;

type ArtifactKind = 'recording' | 'video';

interface CommandOptions {
  json: boolean;
  sessionId: string;
  format?: string;
  out?: string;
}

function resolveRecordExportFormat(
  format: string | undefined,
): RecordExportFormat {
  const formatResult = RecordExportFormatSchema.safeParse(format);

  if (!formatResult.success) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Record export format must be one of: asciicast, webm.',
      details: {
        format,
      },
      cause: formatResult.error,
    });
  }

  return formatResult.data;
}

async function resolveOutputPath(
  sessionDirectory: string,
  capturedAtSeq: number,
  format: RecordExportFormat,
  outputPath: string | undefined,
): Promise<string> {
  if (outputPath === undefined) {
    await ensureArtifactsDir(sessionDirectory);
    return artifactPath(
      sessionDirectory,
      recordingFilename(capturedAtSeq, format),
    );
  }

  invariant(outputPath.length > 0, 'output path must be a non-empty string');

  const currentWorkingDirectory = process.cwd();
  const resolvedOutputPath = isAbsolute(outputPath)
    ? resolve(outputPath)
    : resolve(currentWorkingDirectory, outputPath);
  const parentDirectory = dirname(resolvedOutputPath);
  const realParentDirectory = await realpath(parentDirectory);
  const parentStats = await lstat(realParentDirectory);

  invariant(
    parentStats.isDirectory(),
    `record export parent directory must be a directory: ${realParentDirectory}`,
  );

  await access(realParentDirectory, fsConstants.W_OK);

  const realOutputPath = resolve(
    realParentDirectory,
    basename(resolvedOutputPath),
  );
  invariant(
    dirname(realOutputPath) === realParentDirectory,
    'record export path must remain within the resolved parent directory',
  );
  return realOutputPath;
}

async function computeFileHash(filePath: string): Promise<string> {
  invariant(filePath.length > 0, 'filePath must be a non-empty string');
  invariant(isAbsolute(filePath), 'filePath must be absolute');
  const fileContents = await readFile(filePath);
  return createHash('sha256').update(fileContents).digest('hex');
}

function resolveCapturedAtSeq(events: ReadonlyArray<{ seq: number }>): number {
  return events.at(-1)?.seq ?? 0;
}

function buildResultLines(result: RecordExportResult): string[] {
  return [
    `Session ID: ${result.sessionId}`,
    `Format: ${result.format}`,
    `Captured At Seq: ${String(result.capturedAtSeq)}`,
    `Artifact Path: ${result.artifactPath}`,
    `Bytes: ${String(result.bytes)}`,
    `SHA256: ${result.sha256}`,
    `Duration: ${String(result.durationMs ?? 0)} ms`,
  ];
}

export async function runRecordExportCommand(
  options: CommandOptions,
): Promise<void> {
  const format = resolveRecordExportFormat(options.format);
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

  try {
    const eventsFile = eventLogPath(sessionDirectory);
    const events = await readEventLogRecords(eventsFile);
    const defaultCapturedAtSeq = resolveCapturedAtSeq(events);
    const artifactOutputPath = await resolveOutputPath(
      sessionDirectory,
      defaultCapturedAtSeq,
      format,
      options.out,
    );

    invariant(
      isAbsolute(artifactOutputPath),
      'record export path must be absolute',
    );

    let artifactKind: ArtifactKind;
    let capturedAtSeq: number;
    let durationMs: number | undefined;
    let artifactMetadata: Record<string, unknown>;
    let resultMetadata: Record<string, unknown>;
    let bytes: number;
    let sha256: string;

    if (format === 'asciicast') {
      const exportArtifact = generateAsciicast(
        options.sessionId,
        manifest,
        events,
      );
      const contentsBuffer = Buffer.from(exportArtifact.contents, 'utf8');

      capturedAtSeq = exportArtifact.capturedAtSeq;
      durationMs = exportArtifact.durationMs;
      artifactKind = 'recording';
      artifactMetadata = {
        format,
        outputPath: artifactOutputPath,
        width: exportArtifact.header.width,
        height: exportArtifact.header.height,
        title: exportArtifact.header.title,
        timestamp: exportArtifact.header.timestamp,
        outputEventCount: exportArtifact.outputEventCount,
        resizeEventCount: exportArtifact.resizeEventCount,
      };
      resultMetadata = {
        width: exportArtifact.header.width,
        height: exportArtifact.header.height,
        title: exportArtifact.header.title,
        timestamp: exportArtifact.header.timestamp,
        outputEventCount: exportArtifact.outputEventCount,
        resizeEventCount: exportArtifact.resizeEventCount,
      };

      if (options.out === undefined) {
        invariant(
          capturedAtSeq === defaultCapturedAtSeq,
          'default asciicast artifact path seq must match exported seq',
        );
      }

      await writeTextFileAtomic({
        path: artifactOutputPath,
        pathLabel: 'record export path',
        contents: exportArtifact.contents,
        writeErrorMessage: `Failed to write record export artifact at ${artifactOutputPath}.`,
      });

      bytes = contentsBuffer.byteLength;
      invariant(bytes > 0, 'asciicast export artifact must not be empty');
      sha256 = createHash('sha256').update(contentsBuffer).digest('hex');
    } else {
      invariant(events.length > 0, 'webm export requires at least one event');
      const webmResult: WebmExportResult = await generateWebmExport(
        {
          sessionId: options.sessionId,
          sessionDir: sessionDirectory,
          manifest,
          events,
          outputPath: artifactOutputPath,
        },
        {
          backendFactory: (sessionId, profile, videoOptions) =>
            new GhosttyWebBackend(sessionId, profile, videoOptions),
        },
      );

      capturedAtSeq = webmResult.capturedAtSeq;
      durationMs = webmResult.durationMs;
      artifactKind = 'video';
      artifactMetadata = {
        format,
        outputPath: artifactOutputPath,
        width: webmResult.cols,
        height: webmResult.rows,
        profileName: webmResult.profileName,
        timingMode: webmResult.timingMode,
        outputEventCount: webmResult.outputEventCount,
        resizeEventCount: webmResult.resizeEventCount,
      };
      resultMetadata = {
        width: webmResult.cols,
        height: webmResult.rows,
        profileName: webmResult.profileName,
        timingMode: webmResult.timingMode,
        outputEventCount: webmResult.outputEventCount,
        resizeEventCount: webmResult.resizeEventCount,
      };

      if (options.out === undefined) {
        invariant(
          capturedAtSeq === defaultCapturedAtSeq,
          'default webm artifact path seq must match exported seq',
        );
      }

      const stats = await stat(artifactOutputPath);
      bytes = stats.size;
      invariant(bytes > 0, 'webm export artifact must not be empty');
      sha256 = await computeFileHash(artifactOutputPath);
    }

    await appendArtifact(
      sessionDirectory,
      createArtifactEntry({
        kind: artifactKind,
        filename: basename(artifactOutputPath),
        sessionId: manifest.sessionId,
        capturedAtSeq,
        sha256,
        bytes,
        metadata: artifactMetadata,
      }),
    );

    const rawResult = {
      sessionId: manifest.sessionId,
      format,
      artifactPath: artifactOutputPath,
      bytes,
      sha256,
      capturedAtSeq,
      durationMs,
      metadata: resultMetadata,
    };
    const parsedResult = RecordExportResultSchema.safeParse(rawResult);

    if (!parsedResult.success) {
      throw makeCliError(ERROR_CODES.INTERNAL_ERROR, {
        message: 'Generated record export result did not match the schema.',
        details: {
          issues: parsedResult.error.issues,
        },
        cause: parsedResult.error,
      });
    }

    emitSuccess({
      command: 'record export',
      json: options.json,
      result: parsedResult.data,
      lines: buildResultLines(parsedResult.data),
    });
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
      message: `Failed to export session "${options.sessionId}" as ${format}.`,
      details: {
        sessionId: options.sessionId,
        format,
        out: options.out,
      },
      cause: error,
    });
  }
}
