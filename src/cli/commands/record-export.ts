import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { emitSuccess } from '../output.js';
import { generateAsciicast } from '../../export/asciicast.js';
import { readEventLogRecords } from '../../host/replay.js';
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

interface CommandOptions {
  json: boolean;
  sessionId: string;
  format?: string;
  out?: string;
}

function assertPathWithinRoot(
  pathValue: string,
  rootDirectory: string,
  message: string,
): void {
  const relativePath = relative(rootDirectory, resolve(pathValue));

  invariant(
    relativePath === '' ||
      (!relativePath.startsWith(`..${sep}`) &&
        relativePath !== '..' &&
        !isAbsolute(relativePath)),
    message,
  );
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
  outputPath: string | undefined,
): Promise<string> {
  if (outputPath === undefined) {
    await ensureArtifactsDir(sessionDirectory);
    return artifactPath(
      sessionDirectory,
      recordingFilename(capturedAtSeq, 'asciicast'),
    );
  }

  invariant(outputPath.length > 0, 'output path must be a non-empty string');

  if (isAbsolute(outputPath)) {
    return resolve(outputPath);
  }

  const currentWorkingDirectory = process.cwd();
  const resolvedOutputPath = resolve(currentWorkingDirectory, outputPath);
  assertPathWithinRoot(
    resolvedOutputPath,
    currentWorkingDirectory,
    'relative output path must stay within the current working directory',
  );
  return resolvedOutputPath;
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

  if (format !== 'asciicast') {
    throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
      message: `Record export format "${format}" is not implemented yet.`,
      details: {
        sessionId: options.sessionId,
        format,
      },
    });
  }

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
    const exportArtifact = generateAsciicast(
      options.sessionId,
      manifest,
      events,
    );
    const artifactOutputPath = await resolveOutputPath(
      sessionDirectory,
      exportArtifact.capturedAtSeq,
      options.out,
    );
    const contentsBuffer = Buffer.from(exportArtifact.contents, 'utf8');
    const bytes = contentsBuffer.byteLength;
    const sha256 = createHash('sha256').update(contentsBuffer).digest('hex');

    await writeTextFileAtomic({
      path: artifactOutputPath,
      pathLabel: 'record export path',
      contents: exportArtifact.contents,
      writeErrorMessage: `Failed to write record export artifact at ${artifactOutputPath}.`,
    });

    await appendArtifact(
      sessionDirectory,
      createArtifactEntry({
        kind: 'recording',
        filename: basename(artifactOutputPath),
        sessionId: manifest.sessionId,
        capturedAtSeq: exportArtifact.capturedAtSeq,
        sha256,
        bytes,
        metadata: {
          format,
          outputPath: artifactOutputPath,
          width: exportArtifact.header.width,
          height: exportArtifact.header.height,
          title: exportArtifact.header.title,
          timestamp: exportArtifact.header.timestamp,
          outputEventCount: exportArtifact.outputEventCount,
          resizeEventCount: exportArtifact.resizeEventCount,
        },
      }),
    );

    const rawResult = {
      sessionId: manifest.sessionId,
      format,
      artifactPath: artifactOutputPath,
      bytes,
      sha256,
      capturedAtSeq: exportArtifact.capturedAtSeq,
      durationMs: exportArtifact.durationMs,
      metadata: {
        width: exportArtifact.header.width,
        height: exportArtifact.header.height,
        title: exportArtifact.header.title,
        timestamp: exportArtifact.header.timestamp,
        outputEventCount: exportArtifact.outputEventCount,
        resizeEventCount: exportArtifact.resizeEventCount,
      },
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
      message: `Failed to export session "${options.sessionId}" as asciicast.`,
      details: {
        sessionId: options.sessionId,
        format,
        out: options.out,
      },
      cause: error,
    });
  }
}
