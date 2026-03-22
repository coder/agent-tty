import type {
  WaitForRenderResult,
  WaitResult,
} from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import {
  WaitForRenderResultSchema,
  WaitResultSchema,
} from '../../protocol/schemas.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { resolveHome } from '../../storage/home.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

interface CommandOptions {
  json: boolean;
  sessionId: string;
  waitForExit: boolean;
  idleMs: number | undefined;
  timeout: number | undefined;
  text: string | undefined;
  regex: string | undefined;
  screenStableMs: number | undefined;
  cursorRow: number | undefined;
  cursorCol: number | undefined;
}

const DEFAULT_WAIT_TIMEOUT_MS = 600_000;

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

function isRenderWaitMode(options: CommandOptions): boolean {
  return (
    options.text !== undefined ||
    options.regex !== undefined ||
    options.screenStableMs !== undefined ||
    options.cursorRow !== undefined ||
    options.cursorCol !== undefined
  );
}

function waitLines(result: WaitResult): string[] {
  if (result.timedOut) {
    return ['Wait timed out.'];
  }

  if (result.exitCode !== undefined) {
    return [`Process exited with code ${String(result.exitCode)}.`];
  }

  return ['Wait condition met.'];
}

function renderWaitLines(result: WaitForRenderResult): string[] {
  if (result.timedOut) {
    return [`Wait timed out. (capturedAtSeq: ${String(result.capturedAtSeq)})`];
  }

  const lines: string[] = [];
  if (result.matchedText !== undefined) {
    lines.push(`Matched: ${result.matchedText}`);
  } else {
    lines.push('Wait condition met.');
  }
  if (result.cursorRow !== undefined && result.cursorCol !== undefined) {
    lines.push(
      `Cursor: row ${String(result.cursorRow)}, col ${String(result.cursorCol)}`,
    );
  }
  lines.push(`capturedAtSeq: ${String(result.capturedAtSeq)}`);
  return lines;
}

export async function runWaitCommand(options: CommandOptions): Promise<void> {
  const home = resolveHome();
  const sessionDirectory = sessionDir(home, options.sessionId);
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

  const renderMode = isRenderWaitMode(options);
  const legacyMode = options.waitForExit || options.idleMs !== undefined;

  if (renderMode && legacyMode) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message:
        'Cannot mix legacy wait flags (--exit, --idle-ms) with render wait flags (--text, --regex, --screen-stable-ms, --cursor-row, --cursor-col).',
    });
  }

  if (renderMode) {
    if (options.text !== undefined && options.regex !== undefined) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: '--text and --regex are mutually exclusive.',
      });
    }

    if (
      options.screenStableMs !== undefined &&
      !isPositiveInteger(options.screenStableMs)
    ) {
      throw makeCliError(ERROR_CODES.INVALID_DURATION, {
        message: '--screen-stable-ms must be a positive integer.',
        details: { screenStableMs: options.screenStableMs },
      });
    }

    if (
      options.cursorRow !== undefined &&
      !isNonNegativeInteger(options.cursorRow)
    ) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: '--cursor-row must be a non-negative integer.',
        details: { cursorRow: options.cursorRow },
      });
    }

    if (
      options.cursorCol !== undefined &&
      !isNonNegativeInteger(options.cursorCol)
    ) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: '--cursor-col must be a non-negative integer.',
        details: { cursorCol: options.cursorCol },
      });
    }

    if (
      options.timeout !== undefined &&
      options.timeout !== 0 &&
      !isPositiveInteger(options.timeout)
    ) {
      throw makeCliError(ERROR_CODES.INVALID_DURATION, {
        message: '--timeout must be a non-negative integer (0 for infinite).',
        details: {
          timeout: options.timeout,
        },
      });
    }

    const effectiveTimeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const params = {
      text: options.text,
      regex: options.regex,
      screenStableMs: options.screenStableMs,
      cursorRow: options.cursorRow,
      cursorCol: options.cursorCol,
      timeoutMs: effectiveTimeout === 0 ? undefined : effectiveTimeout,
    };
    const clientTimeout = effectiveTimeout === 0 ? 0 : effectiveTimeout + 5_000;
    const rawResult: unknown = await sendRpc(
      socketPath(sessionDirectory),
      'waitForRender',
      params,
      clientTimeout,
    );
    const parsedResult = WaitForRenderResultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
        message: 'Unexpected response from host',
        details: { issues: parsedResult.error.issues },
      });
    }
    const result: WaitForRenderResult = parsedResult.data;

    emitSuccess({
      command: 'wait',
      json: options.json,
      result,
      lines: renderWaitLines(result),
    });
    return;
  }

  const hasIdleMs = options.idleMs !== undefined;
  if (options.waitForExit === hasIdleMs) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: 'Specify exactly one of --exit or --idle-ms.',
    });
  }

  if (hasIdleMs && !isPositiveInteger(options.idleMs)) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: '--idle-ms must be a positive integer.',
      details: {
        idleMs: options.idleMs,
      },
    });
  }

  if (
    options.timeout !== undefined &&
    options.timeout !== 0 &&
    !isPositiveInteger(options.timeout)
  ) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: '--timeout must be a non-negative integer (0 for infinite).',
      details: {
        timeout: options.timeout,
      },
    });
  }

  if (!options.waitForExit && manifest.status !== 'running') {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  if (options.waitForExit && manifest.status === 'exited') {
    const result: WaitResult = {
      timedOut: false,
      ...(manifest.exitCode === null ? {} : { exitCode: manifest.exitCode }),
    };

    emitSuccess({
      command: 'wait',
      json: options.json,
      result,
      lines: waitLines(result),
    });
    return;
  }

  const effectiveTimeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
  const params = {
    exit: options.waitForExit || undefined,
    idleMs: options.idleMs ?? undefined,
    timeoutMs: effectiveTimeout === 0 ? undefined : effectiveTimeout,
  };
  const clientTimeout = effectiveTimeout === 0 ? 0 : effectiveTimeout + 5_000;
  const rawResult: unknown = await sendRpc(
    socketPath(sessionDirectory),
    'wait',
    params,
    clientTimeout,
  );
  const parsedResult = WaitResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }
  const result: WaitResult = parsedResult.data;

  emitSuccess({
    command: 'wait',
    json: options.json,
    result,
    lines: waitLines(result),
  });
}
