import { randomBytes } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  readValidatedJsonFile,
  writeTextFileAtomic,
  writeValidatedJsonFile,
} from '../../src/storage/manifests.js';
import { assertString, invariant } from '../../src/util/assert.js';
import { EvalResultSchema, RunMetadataSchema } from './schemas.js';
import type { EvalResult, RunMetadata } from './types.js';

const TRANSCRIPT_FILENAME = 'transcript.txt';
const RESULT_FILENAME = 'result.json';
const METADATA_FILENAME = 'metadata.json';

interface NodeError {
  code?: string;
}

function isEnoentError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === 'ENOENT'
  );
}

function assertPathInsideBase(
  baseDir: string,
  candidatePath: string,
  label: string,
): string {
  const normalizedBaseDir = resolve(baseDir);
  const normalizedCandidatePath = resolve(candidatePath);
  const relativePath = relative(normalizedBaseDir, normalizedCandidatePath);

  invariant(
    relativePath === '' ||
      (!relativePath.startsWith('..') && !isAbsolute(relativePath)),
    `${label} must stay within base directory ${normalizedBaseDir}`,
  );

  return normalizedCandidatePath;
}

function resolveWithinBase(
  baseDir: string,
  label: string,
  ...segments: string[]
): string {
  return assertPathInsideBase(baseDir, resolve(baseDir, ...segments), label);
}

function validateEvalResultData(
  path: string,
  data: unknown,
  expectedRunId: string,
  expectedCaseId: string,
): EvalResult {
  const parsedResult = EvalResultSchema.safeParse(data);
  if (!parsedResult.success) {
    throw new Error(
      `Eval result validation failed for ${path}: ${parsedResult.error.message}`,
    );
  }

  invariant(
    parsedResult.data.runId === expectedRunId,
    `Eval result runId mismatch for ${path}: expected ${expectedRunId}, got ${parsedResult.data.runId}`,
  );
  invariant(
    parsedResult.data.caseId === expectedCaseId,
    `Eval result caseId mismatch for ${path}: expected ${expectedCaseId}, got ${parsedResult.data.caseId}`,
  );

  return parsedResult.data as EvalResult;
}

function validateRunMetadataData(
  path: string,
  data: unknown,
  expectedRunId: string,
): RunMetadata {
  const parsedMetadata = RunMetadataSchema.safeParse(data);
  if (!parsedMetadata.success) {
    throw new Error(
      `Run metadata validation failed for ${path}: ${parsedMetadata.error.message}`,
    );
  }

  invariant(
    parsedMetadata.data.runId === expectedRunId,
    `Run metadata runId mismatch for ${path}: expected ${expectedRunId}, got ${parsedMetadata.data.runId}`,
  );

  return parsedMetadata.data as RunMetadata;
}

function warnSkippedResult(resultPath: string, error: unknown): void {
  const details = error instanceof Error ? error.message : String(error);
  console.warn(`[evals] Skipping result at ${resultPath}: ${details}`);
}

/**
 * Validate that a path segment is safe to use in a filesystem path.
 */
export function validatePathSegment(segment: string, label: string): void {
  assertString(label, 'label must be a string');
  assertString(segment, `${label} must be a string`);
  invariant(segment.length > 0, `${label} must be a non-empty string`);
  invariant(segment !== '.', `${label} must not be "."`);
  invariant(segment !== '..', `${label} must not be ".."`);
  invariant(!segment.includes('/'), `${label} must not contain "/"`);
  invariant(!segment.includes('\\'), `${label} must not contain "\\"`);
  invariant(
    !segment.includes(String.fromCharCode(0)),
    `${label} must not contain null bytes`,
  );
}

/**
 * Generate a unique eval run identifier.
 */
export function generateRunId(): string {
  const isoTimestamp = new Date().toISOString();
  const timestamp = `${isoTimestamp.slice(0, 10).replace(/-/g, '')}-${isoTimestamp
    .slice(11, 19)
    .replace(/:/g, '')}`;
  const randomSuffix = randomBytes(3).toString('hex');

  invariant(
    randomSuffix.length === 6,
    'eval run ID random suffix must be 6 hex characters',
  );

  return `eval-${timestamp}-${randomSuffix}`;
}

/**
 * Store eval transcripts, per-case results, and per-run metadata under a base directory.
 */
export class EvalArtifactStore {
  private readonly baseDir: string;

  /**
   * Create an artifact store rooted at the provided base directory.
   */
  public constructor(baseDir: string) {
    assertString(baseDir, 'baseDir must be a string');
    invariant(baseDir.length > 0, 'baseDir must be a non-empty string');

    this.baseDir = resolve(baseDir);
    invariant(isAbsolute(this.baseDir), 'resolved baseDir must be absolute');
  }

  /**
   * Save a transcript for a run/case pair and return the absolute file path.
   */
  public async saveTranscript(
    runId: string,
    caseId: string,
    transcript: string,
  ): Promise<string> {
    assertString(transcript, 'transcript must be a string');

    const caseDirectory = this.caseDir(runId, caseId);
    await mkdir(caseDirectory, { recursive: true });

    const transcriptPath = resolveWithinBase(
      this.baseDir,
      'eval transcript path',
      runId,
      caseId,
      TRANSCRIPT_FILENAME,
    );

    await writeTextFileAtomic({
      path: transcriptPath,
      pathLabel: 'eval transcript path',
      contents: transcript,
      writeErrorMessage: `Failed to write eval transcript at ${transcriptPath}.`,
    });

    return transcriptPath;
  }

  /**
   * Save a validated eval result for a run/case pair and return the absolute file path.
   */
  public async saveResult(runId: string, result: EvalResult): Promise<string> {
    validatePathSegment(runId, 'runId');
    validatePathSegment(result.caseId, 'result.caseId');
    invariant(
      result.runId === runId,
      'result.runId must match the provided runId',
    );

    const caseDirectory = this.caseDir(runId, result.caseId);
    await mkdir(caseDirectory, { recursive: true });

    const resultPath = resolveWithinBase(
      this.baseDir,
      'eval result path',
      runId,
      result.caseId,
      RESULT_FILENAME,
    );

    await writeValidatedJsonFile({
      path: resultPath,
      pathLabel: 'eval result path',
      data: result,
      writeErrorMessage: `Failed to write eval result at ${resultPath}.`,
      validate: (path, data) =>
        validateEvalResultData(path, data, runId, result.caseId),
    });

    return resultPath;
  }

  /**
   * Load all valid results for a run, skipping invalid files with a warning.
   */
  public async loadResults(runId: string): Promise<EvalResult[]> {
    const runDirectory = this.runDir(runId);

    let runDirectoryStats;
    try {
      runDirectoryStats = await stat(runDirectory);
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }

      throw error;
    }

    invariant(
      runDirectoryStats.isDirectory(),
      `run directory must be a directory: ${runDirectory}`,
    );

    const caseEntries = await readdir(runDirectory, { withFileTypes: true });
    const results: EvalResult[] = [];

    for (const caseEntry of caseEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!caseEntry.isDirectory()) {
        continue;
      }

      try {
        validatePathSegment(caseEntry.name, 'caseId');
      } catch (error) {
        warnSkippedResult(
          resolveWithinBase(
            this.baseDir,
            'eval result path',
            runId,
            caseEntry.name,
            RESULT_FILENAME,
          ),
          error,
        );
        continue;
      }

      const resultPath = resolveWithinBase(
        this.baseDir,
        'eval result path',
        runId,
        caseEntry.name,
        RESULT_FILENAME,
      );

      try {
        const result = await readValidatedJsonFile({
          path: resultPath,
          pathLabel: 'eval result path',
          allowMissing: true,
          readErrorMessage: `Failed to read eval result at ${resultPath}.`,
          invalidJsonMessage: `Eval result contains invalid JSON at ${resultPath}.`,
          validate: (path, data) =>
            validateEvalResultData(path, data, runId, caseEntry.name),
        });

        if (result !== null) {
          results.push(result);
        }
      } catch (error) {
        warnSkippedResult(resultPath, error);
      }
    }

    return results;
  }

  /**
   * Save validated metadata for a run and return the absolute file path.
   */
  public async saveRunMetadata(
    runId: string,
    metadata: RunMetadata,
  ): Promise<string> {
    validatePathSegment(runId, 'runId');
    invariant(
      metadata.runId === runId,
      'metadata.runId must match the provided runId',
    );

    const runDirectory = this.runDir(runId);
    await mkdir(runDirectory, { recursive: true });

    const metadataPath = resolveWithinBase(
      this.baseDir,
      'eval metadata path',
      runId,
      METADATA_FILENAME,
    );

    await writeValidatedJsonFile({
      path: metadataPath,
      pathLabel: 'eval metadata path',
      data: metadata,
      writeErrorMessage: `Failed to write eval metadata at ${metadataPath}.`,
      validate: (path, data) => validateRunMetadataData(path, data, runId),
    });

    return metadataPath;
  }

  /**
   * Load validated metadata for a run, or return undefined when it does not exist.
   */
  public async loadRunMetadata(
    runId: string,
  ): Promise<RunMetadata | undefined> {
    validatePathSegment(runId, 'runId');

    const metadataPath = resolveWithinBase(
      this.baseDir,
      'eval metadata path',
      runId,
      METADATA_FILENAME,
    );

    const metadata = await readValidatedJsonFile({
      path: metadataPath,
      pathLabel: 'eval metadata path',
      allowMissing: true,
      readErrorMessage: `Failed to read eval metadata at ${metadataPath}.`,
      invalidJsonMessage: `Eval metadata contains invalid JSON at ${metadataPath}.`,
      validate: (path, data) => validateRunMetadataData(path, data, runId),
    });

    return metadata ?? undefined;
  }

  /**
   * Return the absolute path for a run directory.
   */
  public runDir(runId: string): string {
    validatePathSegment(runId, 'runId');
    return resolveWithinBase(this.baseDir, 'run directory', runId);
  }

  /**
   * Return the absolute path for a case directory.
   */
  public caseDir(runId: string, caseId: string): string {
    validatePathSegment(runId, 'runId');
    validatePathSegment(caseId, 'caseId');
    return resolveWithinBase(this.baseDir, 'case directory', runId, caseId);
  }
}
