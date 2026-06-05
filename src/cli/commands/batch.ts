import assert from 'node:assert/strict';
import { lstat, readFile, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import process from 'node:process';

import type { CommandContext } from '../context.js';
import type { BatchPlan } from '../../batch/plan.js';
import type { BatchResult, BatchStepRecord } from '../../batch/result.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { exitCodeForError } from '../exitCodes.js';
import { emitSuccess } from '../output.js';
import { assertSessionCommandable } from '../sessionGuards.js';
import { executeBatch } from '../../batch/executor.js';
import { parseBatchPlan } from '../../batch/plan.js';
import { buildPartialBatchResult } from '../../batch/result.js';
import { createRpcStepDriver } from '../../batch/stepDriver.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { MAX_INPUT_FILE_SIZE } from './inputSource.js';

/** Fixed batch-level exit code for a keep-going run with any failed step. */
const KEEP_GOING_FAILURE_EXIT_CODE = 1;

/** Signals that flush a partial Batch envelope and exit. */
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/**
 * The conventional 128 + signal-number exit code (SIGINT -> 130,
 * SIGTERM -> 143), falling back to a non-zero code if the number is unknown.
 */
function signalExitCode(signal: InterruptSignal): number {
  const signo = osConstants.signals[signal];
  return typeof signo === 'number' ? 128 + signo : KEEP_GOING_FAILURE_EXIT_CODE;
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  steps: string | undefined;
  file?: string;
  keepGoing: boolean;
}

const BATCH_USAGE =
  'Usage: agent-tty batch <session-id> [steps] [--file <path>]';

function invalidInput(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): ReturnType<typeof makeCliError> {
  return makeCliError(ERROR_CODES.INVALID_INPUT, {
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function inputFileError(
  filePath: string,
  error: unknown,
): ReturnType<typeof makeCliError> {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    return invalidInput(
      `Steps file "${filePath}" was not found.`,
      { file: filePath },
      error,
    );
  }
  if (
    isErrnoException(error) &&
    ['EACCES', 'EPERM'].includes(error.code ?? '')
  ) {
    return invalidInput(
      `Steps file "${filePath}" is not readable.`,
      { file: filePath },
      error,
    );
  }
  return invalidInput(
    `Failed to read steps file "${filePath}".`,
    { file: filePath },
    error,
  );
}

/**
 * Resolve the raw JSON step source from the positional argument XOR --file.
 * Mirrors the safety of resolveCommandInputText (lstat, regular-file only,
 * 10 MB cap, non-empty) but returns the raw string unchanged — it is JSON to be
 * parsed, not "text" to be typed.
 */
async function resolveBatchSource(options: CommandOptions): Promise<string> {
  if (options.steps !== undefined && options.file !== undefined) {
    throw invalidInput(
      `Positional [steps] argument and --file are mutually exclusive. ${BATCH_USAGE}`,
      { steps: options.steps, file: options.file },
    );
  }

  if (options.steps === undefined && options.file === undefined) {
    throw invalidInput(
      `Missing steps. Provide either a positional [steps] JSON array or --file <path>. ${BATCH_USAGE}`,
    );
  }

  if (options.steps !== undefined) {
    if (options.steps.length === 0) {
      throw invalidInput('Steps must not be empty.');
    }
    return options.steps;
  }

  const filePath = options.file;
  assert(typeof filePath === 'string', '--file must resolve to a string path');
  assert(filePath.length > 0, '--file path must be a non-empty string');

  let fileStats: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStats = await lstat(filePath);
  } catch (error: unknown) {
    throw inputFileError(filePath, error);
  }

  if (!fileStats.isFile()) {
    throw invalidInput(
      `Steps file "${filePath}" must be a regular file. Directories, symlinks, and device files are not supported.`,
      { file: filePath },
    );
  }

  const contentStats = await stat(filePath).catch((error: unknown) => {
    throw inputFileError(filePath, error);
  });
  if (contentStats.size > MAX_INPUT_FILE_SIZE) {
    throw invalidInput(
      `Steps file "${filePath}" exceeds the 10 MB limit for --file input.`,
      {
        file: filePath,
        sizeBytes: contentStats.size,
        maxSizeBytes: MAX_INPUT_FILE_SIZE,
      },
    );
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw inputFileError(filePath, error);
  }

  if (content.length === 0) {
    throw invalidInput(`Steps file "${filePath}" must not be empty.`, {
      file: filePath,
    });
  }

  return content;
}

function stepOutcome(record: BatchStepRecord): string {
  if (record.status === 'not-run') {
    return 'not-run';
  }
  if (record.status === 'failed') {
    return record.error === undefined
      ? 'failed'
      : `failed (${record.error.code})`;
  }
  switch (record.kind) {
    case 'wait':
      return record.matchedText === undefined
        ? 'matched'
        : `matched "${record.matchedText}"`;
    case 'run':
      return record.runOutcome ?? 'completed';
    case 'type':
    case 'paste':
    case 'sendKeys':
      return 'completed';
  }
}

function firstFailedStep(result: BatchResult): BatchStepRecord | undefined {
  const firstFailedIndex = result.failedIndices[0];
  if (firstFailedIndex === undefined) {
    return undefined;
  }
  return result.steps.find((record) => record.index === firstFailedIndex);
}

function stepFailureReason(record: BatchStepRecord): string {
  if (record.status !== 'failed' || record.error === undefined) {
    return 'failed';
  }
  return `${record.error.code}: ${record.error.message}`;
}

export function buildBatchLines(
  result: BatchResult,
  keepGoing = false,
): string[] {
  const lines = result.steps.map(
    (record) =>
      `[${String(record.index)}] ${record.kind} ${stepOutcome(record)} (${String(record.durationMs)}ms)`,
  );
  lines.push(
    `${String(result.completedCount)}/${String(result.steps.length)} steps completed`,
  );

  if (result.failedIndices.length > 0) {
    if (keepGoing) {
      lines.push(`failed steps: ${result.failedIndices.join(', ')}`);
    } else {
      const failed = firstFailedStep(result);
      const index = result.failedIndices[0];
      lines.push(
        `failed at step ${String(index)}: ${failed === undefined ? 'failed' : stepFailureReason(failed)}`,
      );
    }
  }

  return lines;
}

interface InterruptFlushOptions {
  plan: BatchPlan;
  json: boolean;
  keepGoing: boolean;
}

/**
 * Run the executor with a synchronous SIGINT/SIGTERM handler that flushes a
 * partial Batch envelope and exits, then removes the handler.
 *
 * The handler accumulates each finalized step record through `onStep`. On a
 * signal it builds a partial BatchResult from those records (the in-flight step
 * recorded `interrupted`, later steps `not-run`), writes the same envelope a
 * normal run would, and calls `process.exit`. It deliberately does NOT await
 * the in-flight RPC: a `wait` step interrupted mid-flight leaves the underlying
 * Render Wait registered and that command still RUNNING on the Session
 * (`forgetWaiter` keeps the sentinel registered), exactly like caller-timeout —
 * see CONTEXT.md ("Caller timeout does not cancel the underlying Run
 * Completion"). Already-applied input cannot be undone; a Batch is not atomic.
 */
async function executeWithInterruptFlush(
  options: InterruptFlushOptions,
  run: (onStep: (record: BatchStepRecord) => void) => Promise<BatchResult>,
): Promise<BatchResult> {
  const records: BatchStepRecord[] = [];
  let flushed = false;

  const handleSignal = (signal: InterruptSignal): void => {
    // A second signal during the flush must not re-enter and double-write.
    if (flushed) {
      return;
    }
    flushed = true;

    const partial = buildPartialBatchResult(options.plan, records);
    emitSuccess({
      command: 'batch',
      json: options.json,
      result: partial,
      lines: buildBatchLines(partial, options.keepGoing),
    });
    process.exit(signalExitCode(signal));
  };

  const handlers = INTERRUPT_SIGNALS.map((signal) => {
    const handler = (): void => {
      handleSignal(signal);
    };
    process.on(signal, handler);
    return { signal, handler } as const;
  });

  try {
    return await run((record) => {
      records.push(record);
    });
  } finally {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  }
}

export async function runBatchCommand(options: CommandOptions): Promise<void> {
  const raw = await resolveBatchSource(options);

  // Parse precedes target resolution: a malformed plan fails fast with no live
  // Session required, and a Batch is not atomic — nothing should be sent until
  // the whole plan is validated.
  const plan = parseBatchPlan(raw);

  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

  const driver = createRpcStepDriver(
    target.socketPath,
    options.context.rendererDefault,
  );

  // Re-read the manifest around each Render Wait so a Session that exits or is
  // destroyed mid-Batch fails the wait step rather than racing a dead Session.
  const assertCommandable = async (): Promise<void> => {
    const manifest = await readManifestIfExists(target.manifestPath);
    if (manifest === null) {
      throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
        message: `Session "${options.sessionId}" was not found.`,
        details: {
          sessionId: options.sessionId,
          manifestPath: target.manifestPath,
        },
      });
    }
    assertSessionCommandable(manifest, options.sessionId);
  };

  const result = await executeWithInterruptFlush(
    { plan, json: options.json, keepGoing: options.keepGoing },
    (onStep) =>
      executeBatch({
        plan,
        driver,
        keepGoing: options.keepGoing,
        assertCommandable,
        onStep,
      }),
  );

  // Exit codes follow the doctor pattern: set process.exitCode, then always
  // emitSuccess with the full BatchResult so the per-step envelope is never
  // lost. Routing a step failure through emitFailure would discard steps[].
  if (result.failedIndices.length > 0) {
    if (options.keepGoing) {
      process.exitCode = KEEP_GOING_FAILURE_EXIT_CODE;
    } else {
      const failed = firstFailedStep(result);
      process.exitCode =
        failed?.status === 'failed' && failed.error !== undefined
          ? exitCodeForError(failed.error.code)
          : KEEP_GOING_FAILURE_EXIT_CODE;
    }
  }

  emitSuccess({
    command: 'batch',
    json: options.json,
    result,
    lines: buildBatchLines(result, options.keepGoing),
  });
}
