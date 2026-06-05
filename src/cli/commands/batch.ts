import assert from 'node:assert/strict';
import { lstat, readFile, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import process from 'node:process';

import type { CommandContext } from '../context.js';
import type { BatchPlan } from '../../batch/plan.js';
import type { BatchResult, BatchStepRecord } from '../../batch/result.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { exitCodeForError } from '../exitCodes.js';
import { emitSuccess, emitSuccessSync } from '../output.js';
import { executeBatch } from '../../batch/executor.js';
import { parseBatchPlan } from '../../batch/plan.js';
import { buildPartialBatchResult } from '../../batch/result.js';
import { createRpcStepDriver } from '../../batch/stepDriver.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { MAX_INPUT_FILE_SIZE } from './inputSource.js';

const KEEP_GOING_FAILURE_EXIT_CODE = 1;

const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

// Conventional 128 + signal-number exit code (SIGINT -> 130, SIGTERM -> 143).
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

// Resolve the raw JSON step source from the positional argument XOR --file,
// with the same file safety as resolveCommandInputText (regular file, 10 MB cap).
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
  if (record.status === 'interrupted') {
    return 'interrupted';
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
 * Run the executor under SIGINT/SIGTERM handlers that flush a partial envelope
 * (in-flight step `interrupted`, later steps `not-run`) and exit. The in-flight
 * RPC is NOT awaited, so an interrupted Waited Run keeps running on the Session
 * — like caller-timeout (CONTEXT.md); already-applied input cannot be undone.
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
    // Sync flush: an async write would be truncated by the process.exit below
    // for a partial envelope larger than the OS pipe buffer.
    emitSuccessSync({
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

  // Parse before resolving the target: a malformed plan fails fast without a
  // live Session, and nothing is sent until the whole plan validates.
  const plan = parseBatchPlan(raw);

  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

  const driver = createRpcStepDriver(
    target.socketPath,
    options.context.rendererDefault,
  );

  // Re-resolve the target around each Render Wait (fresh manifest read) so a
  // Session that dies mid-Batch fails the wait rather than racing a dead one.
  const assertCommandable = async (): Promise<void> => {
    await resolveCommandTarget({
      home: options.context.home,
      sessionId: options.sessionId,
    });
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

  // Set process.exitCode then always emitSuccess (doctor pattern), so a failed
  // Batch still emits the full per-step envelope instead of a bare error.
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
