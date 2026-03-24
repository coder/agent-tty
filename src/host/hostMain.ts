import { rename, rm } from 'node:fs/promises';
import process from 'node:process';

import { ulid } from 'ulid';

import { EventLog } from './eventLog.js';
import { buildReplayInput } from './replay.js';
import { HostRendererManager } from './renderer.js';
import { RpcServer, type MethodHandler } from './rpcServer.js';
import { SessionState } from './sessionState.js';
import { createPty } from '../pty/createPty.js';
import { encodeKey } from '../pty/keyEncoder.js';
import { encodePaste } from '../pty/pasteEncoder.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import type {
  MarkParams,
  PasteParams,
  ResizeParams,
  ScreenshotParams,
  SendKeysParams,
  SignalParams,
  SnapshotParams,
  TypeParams,
  WaitForRenderParams,
  WaitForRenderResult,
  WaitParams,
} from '../protocol/messages.js';
import { GhosttyWebBackend } from '../renderer/ghosttyWeb/index.js';
import { resolveProfile } from '../renderer/profiles.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  screenshotFilename,
  snapshotFilename,
} from '../storage/artifactPaths.js';
import { resolveHome } from '../storage/home.js';
import {
  readManifest,
  writeManifest,
  writeTextFileAtomic,
} from '../storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../storage/sessionPaths.js';
import { invariant } from '../util/assert.js';

const ALLOWED_SIGNALS = [
  'SIGTERM',
  'SIGINT',
  'SIGKILL',
  'SIGHUP',
  'SIGUSR1',
  'SIGUSR2',
] as const;

const DEFAULT_RENDER_PROFILE_NAME = 'reference-dark';
const MAX_WAIT_FOR_RENDER_REGEX_LENGTH = 200;
export const MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH = 50_000;
export const MAX_CONSECUTIVE_POLL_FAILURES = 10;
// Idle-timeout enforcement is polling-based: actual idle duration before kill
// may exceed idleTimeoutMs by up to checkIntervalMs (bounded by this cap).
const IDLE_CHECK_CAP_MS = 5_000;
const BRACED_QUANTIFIER_PATTERN = /^\{(?:\d+|\d+,\d*)\}/;

type WaitOutcome = {
  exitCode?: number;
  timedOut: boolean;
};

function normalizeExitSignal(signal: number | null): string | null {
  invariant(
    signal === null || (Number.isInteger(signal) && signal >= 0),
    'PTY exit signal must be a non-negative integer or null',
  );

  return signal === null || signal === 0 ? null : String(signal);
}

function isSessionRunning(state: SessionState): boolean {
  return state.snapshot().status === 'running';
}

function rethrowAsync(error: unknown): void {
  process.nextTick(() => {
    throw error;
  });
}

function isRegexQuantifierAt(pattern: string, index: number): boolean {
  const nextChar = pattern[index];
  if (nextChar === '*' || nextChar === '+' || nextChar === '?') {
    return true;
  }

  if (nextChar !== '{') {
    return false;
  }

  return BRACED_QUANTIFIER_PATTERN.test(pattern.slice(index));
}

/**
 * Reject regex patterns with obvious ReDoS-prone constructs:
 * - Nested quantifiers: (x+)+, (x*)+, (x+)*, (x?){n}, etc.
 * - Star-height > 1 patterns
 *
 * This is a heuristic check, not a full regex analysis.
 * It catches the most common catastrophic backtracking patterns.
 */
export function hasNestedQuantifiers(pattern: string): boolean {
  invariant(typeof pattern === 'string', 'regex pattern must be a string');

  const groupHasQuantifierStack: boolean[] = [];
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    invariant(char !== undefined, 'regex pattern character must exist');

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      continue;
    }

    if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }

    if (inCharacterClass) {
      continue;
    }

    if (char === '(') {
      groupHasQuantifierStack.push(false);
      continue;
    }

    if (char === ')') {
      const groupHasQuantifier = groupHasQuantifierStack.pop() ?? false;
      const groupIsQuantified = isRegexQuantifierAt(pattern, index + 1);
      if (groupHasQuantifier && groupIsQuantified) {
        return true;
      }

      const parentGroupIndex = groupHasQuantifierStack.length - 1;
      if (parentGroupIndex >= 0 && (groupHasQuantifier || groupIsQuantified)) {
        groupHasQuantifierStack[parentGroupIndex] = true;
      }

      continue;
    }

    const currentGroupIndex = groupHasQuantifierStack.length - 1;
    if (currentGroupIndex < 0) {
      continue;
    }

    if (char === '*' || char === '+' || char === '?') {
      const previousChar = pattern[index - 1];
      if (previousChar !== '(') {
        groupHasQuantifierStack[currentGroupIndex] = true;
      }
      continue;
    }

    if (char === '{' && isRegexQuantifierAt(pattern, index)) {
      groupHasQuantifierStack[currentGroupIndex] = true;
    }
  }

  return false;
}

export function safeRegexExec(
  regex: RegExp,
  text: string,
): RegExpExecArray | null {
  const limitedText =
    text.length > MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH
      ? text.slice(0, MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH)
      : text;
  return regex.exec(limitedText);
}

export async function runHost(sessionId: string): Promise<void> {
  invariant(
    typeof sessionId === 'string' && sessionId.length > 0,
    'sessionId must be a non-empty string',
  );

  const home = resolveHome();
  const sessDir = sessionDir(home, sessionId);
  const mPath = manifestPath(sessDir);
  const ePath = eventLogPath(sessDir);
  const sPath = socketPath(sessDir);

  const manifest = await readManifest(mPath);
  invariant(
    manifest.sessionId === sessionId,
    'session manifest sessionId must match the requested session',
  );
  const idleTimeoutMs = manifest.idleTimeoutMs ?? 0;
  invariant(
    Number.isInteger(idleTimeoutMs) && idleTimeoutMs >= 0,
    'session manifest idleTimeoutMs must be a non-negative integer',
  );

  const state = new SessionState(manifest);
  invariant(
    Number.isInteger(process.pid) && process.pid > 0,
    'process.pid must be a positive integer',
  );
  state.setHostPid(process.pid);

  const eventLog = await EventLog.open(ePath);

  const rendererManager = new HostRendererManager({
    sessionId,
    sessionDir: sessDir,
    backendFactory: (sid, profile) => new GhosttyWebBackend(sid, profile),
  });

  const loadReplayInput = () => {
    const events = [...eventLog.getEvents()];
    const replayInput = buildReplayInput(sessionId, state.snapshot(), events);
    return replayInput.targetSeq === -1 ? null : replayInput;
  };

  let eventLogClosed = false;
  let ptyExitHandled = false;
  let ptyHasExited = false;
  let lastOutputAt = Date.now();
  let lastActivityAt = lastOutputAt;
  let idleTimeoutHandle: ReturnType<typeof setInterval> | null = null;
  let rpcListenPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let markPtyExited: () => void = () => {
    invariant(false, 'PTY exit resolver must be initialized');
  };

  const ptyExitPromise = new Promise<void>((resolve) => {
    markPtyExited = (): void => {
      if (ptyHasExited) {
        return;
      }

      ptyHasExited = true;
      resolve();
    };
  });

  const pty = createPty({
    command: manifest.command,
    cwd: manifest.cwd,
    cols: manifest.cols,
    rows: manifest.rows,
    env: manifest.env ?? {},
    term: manifest.term ?? 'xterm-256color',
  });

  invariant(
    Number.isInteger(pty.pid) && pty.pid > 0,
    'PTY child PID must be a positive integer',
  );
  state.setChildPid(pty.pid);

  const clearIdleTimeout = (): void => {
    // Idempotent: safe to call multiple times during shutdown and PTY exit.
    if (idleTimeoutHandle === null) {
      return;
    }

    clearInterval(idleTimeoutHandle);
    idleTimeoutHandle = null;
  };

  const startIdlePolling = (): void => {
    if (
      idleTimeoutMs <= 0 ||
      !isSessionRunning(state) ||
      idleTimeoutHandle !== null
    ) {
      return;
    }

    const checkIntervalMs = Math.min(idleTimeoutMs, IDLE_CHECK_CAP_MS);
    idleTimeoutHandle = setInterval(() => {
      if (!isSessionRunning(state)) {
        clearIdleTimeout();
        return;
      }

      const elapsedIdleMs = Date.now() - lastActivityAt;
      if (elapsedIdleMs >= idleTimeoutMs) {
        clearIdleTimeout();
        pty.kill();
      }
    }, checkIntervalMs);
  };

  const initiateShutdown = (): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      try {
        clearIdleTimeout();
        if (isSessionRunning(state)) {
          pty.kill();
          state.requestDestroy();
          await writeManifest(mPath, state.snapshot());
        }
      } finally {
        try {
          await ptyExitPromise;
        } finally {
          if (rpcListenPromise !== null) {
            await rpcListenPromise.catch(() => undefined);
          }

          if (!eventLogClosed) {
            await eventLog.close();
            eventLogClosed = true;
          }

          try {
            await rendererManager.dispose();
          } catch {
            // best-effort cleanup
          }

          await rpcServer.close();
        }
      }
    })();

    return shutdownPromise;
  };

  const startShutdown = (): void => {
    void initiateShutdown().catch(rethrowAsync);
  };

  const handlePtyExit = (exitCode: number, signal: number | null): void => {
    invariant(!ptyExitHandled, 'PTY exit must only be handled once');
    invariant(Number.isInteger(exitCode), 'PTY exit code must be an integer');

    ptyExitHandled = true;
    clearIdleTimeout();

    const exitSignal = normalizeExitSignal(signal);
    const currentStatus = state.snapshot().status;

    if (currentStatus === 'destroying') {
      state.recordDestroyed({ exitCode, exitSignal });
    } else {
      state.recordExit(exitCode, exitSignal);
    }
    markPtyExited();

    void (async () => {
      try {
        await eventLog.append('exit', { exitCode, exitSignal });
      } finally {
        try {
          await writeManifest(mPath, state.snapshot());
        } finally {
          await initiateShutdown();
        }
      }
    })().catch(rethrowAsync);
  };

  const handlers: Record<string, MethodHandler> = {
    inspect: () => Promise.resolve({ session: state.snapshot() }),
    snapshot: async (params: unknown) => {
      const {
        format: requestedFormat,
        includeScrollback: requestedIncludeScrollback,
        includeCells: requestedIncludeCells,
      } = params as SnapshotParams;

      const format = requestedFormat ?? 'structured';
      const includeScrollback = requestedIncludeScrollback ?? false;
      const includeCells = requestedIncludeCells ?? false;

      invariant(
        typeof includeScrollback === 'boolean',
        'snapshot includeScrollback must normalize to a boolean',
      );
      invariant(
        typeof includeCells === 'boolean',
        'snapshot includeCells must normalize to a boolean',
      );

      const profile = resolveProfile(DEFAULT_RENDER_PROFILE_NAME);
      const replayInput = loadReplayInput();
      const backend = await rendererManager.getBackend(profile, replayInput);
      const snapshot = await backend.snapshot({
        includeScrollback,
        includeCells,
      });
      const snapshotText = [
        ...(snapshot.scrollbackLines ?? []),
        ...snapshot.visibleLines,
      ]
        .map((line) => line.text)
        .join('\n');

      invariant(
        snapshot.sessionId === sessionId,
        'renderer snapshot sessionId must match host sessionId',
      );

      const snapshotResult =
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
              text: snapshotText,
            };

      await ensureArtifactsDir(sessDir);
      const filename = snapshotFilename(snapshot.capturedAtSeq, format);
      const snapshotArtifactPath = artifactPath(sessDir, filename);

      await writeTextFileAtomic({
        path: snapshotArtifactPath,
        pathLabel: 'snapshot artifact path',
        contents: `${JSON.stringify(snapshotResult, null, 2)}\n`,
        writeErrorMessage: `Failed to write snapshot artifact at ${snapshotArtifactPath}.`,
      });

      await appendArtifact(
        sessDir,
        createArtifactEntry({
          kind: 'snapshot',
          filename,
          sessionId: snapshot.sessionId,
          capturedAtSeq: snapshot.capturedAtSeq,
          metadata: {
            format,
            rendererBackend: backend.rendererBackend,
            cols: snapshot.cols,
            rows: snapshot.rows,
            cursorRow: snapshot.cursorRow,
            cursorCol: snapshot.cursorCol,
            ...(snapshot.scrollbackLines === undefined
              ? {}
              : { scrollbackLineCount: snapshot.scrollbackLines.length }),
          },
        }),
      );

      return snapshotResult;
    },
    screenshot: async (params: unknown) => {
      const { profile: requestedProfileName, showCursor } =
        params as ScreenshotParams;

      const profile = (() => {
        try {
          return resolveProfile(
            requestedProfileName ?? DEFAULT_RENDER_PROFILE_NAME,
          );
        } catch (error) {
          throw makeCliError(ERROR_CODES.INVALID_INPUT, {
            message:
              error instanceof Error
                ? error.message
                : 'Invalid render profile.',
            ...(requestedProfileName === undefined
              ? {}
              : { details: { profile: requestedProfileName } }),
            cause: error,
          });
        }
      })();

      const replayInput = loadReplayInput();
      const backend = await rendererManager.getBackend(profile, replayInput);
      await ensureArtifactsDir(sessDir);
      const temporaryOutputPath = artifactPath(
        sessDir,
        `.tmp-screenshot-${ulid()}.png`,
      );

      try {
        const result = await backend.screenshot(
          temporaryOutputPath,
          showCursor === undefined ? undefined : { showCursor },
        );

        invariant(
          result.sessionId === sessionId,
          'renderer screenshot sessionId must match host sessionId',
        );
        invariant(
          result.profileName === profile.name,
          'renderer screenshot profileName must match the requested profile',
        );
        invariant(
          result.artifactPath === temporaryOutputPath,
          'renderer screenshot path must match the requested output path',
        );
        invariant(
          result.pngSizeBytes > 0,
          'renderer screenshot pngSizeBytes must be positive',
        );

        const filename = screenshotFilename(
          result.capturedAtSeq,
          result.profileName,
        );
        const finalArtifactPath = artifactPath(sessDir, filename);

        await rename(temporaryOutputPath, finalArtifactPath);
        await appendArtifact(
          sessDir,
          createArtifactEntry({
            kind: 'screenshot',
            filename,
            sessionId: result.sessionId,
            capturedAtSeq: result.capturedAtSeq,
            sha256: result.sha256,
            metadata: {
              profileName: result.profileName,
              cols: result.cols,
              rows: result.rows,
              pngSizeBytes: result.pngSizeBytes,
              cursorVisible: result.cursorVisible,
              rendererBackend: result.rendererBackend,
              pixelWidth: result.pixelWidth,
              pixelHeight: result.pixelHeight,
              renderProfileHash: result.renderProfileHash,
            },
          }),
        );

        return {
          sessionId: result.sessionId,
          capturedAtSeq: result.capturedAtSeq,
          profileName: result.profileName,
          cols: result.cols,
          rows: result.rows,
          artifactPath: finalArtifactPath,
          pngSizeBytes: result.pngSizeBytes,
          cursorVisible: result.cursorVisible,
          rendererBackend: result.rendererBackend,
          pixelWidth: result.pixelWidth,
          pixelHeight: result.pixelHeight,
          sha256: result.sha256,
          renderProfileHash: result.renderProfileHash,
        };
      } catch (error) {
        await rm(temporaryOutputPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    type: async (params: unknown) => {
      const { text } = params as TypeParams;

      if (!isSessionRunning(state)) {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Session is not running.',
        });
      }

      invariant(typeof text === 'string', 'type text must be a string');
      pty.write(text);
      lastActivityAt = Date.now();
      await eventLog.append('input_text', { data: text });
      return {};
    },
    mark: async (params: unknown) => {
      const { label } = params as MarkParams;

      if (!isSessionRunning(state)) {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Session is not running.',
        });
      }

      invariant(typeof label === 'string', 'mark label must be a string');
      lastActivityAt = Date.now();
      const seq = await eventLog.append('marker', { label });
      return { seq };
    },
    paste: async (params: unknown) => {
      const { text } = params as PasteParams;

      if (!isSessionRunning(state)) {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Session is not running.',
        });
      }

      invariant(
        typeof text === 'string' && text.length > 0,
        'paste text must be a non-empty string',
      );
      const encoded = encodePaste(text);
      pty.write(encoded);
      lastActivityAt = Date.now();
      await eventLog.append('input_paste', { data: encoded });
      return {};
    },
    sendKeys: async (params: unknown) => {
      const { keys } = params as SendKeysParams;

      if (!isSessionRunning(state)) {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Session is not running.',
        });
      }

      invariant(
        Array.isArray(keys) && keys.length > 0,
        'keys must be a non-empty array',
      );

      let encoded: string;
      try {
        encoded = keys.map((key) => encodeKey(key)).join('');
      } catch (error) {
        throw makeCliError(ERROR_CODES.INVALID_KEYS, {
          message:
            error instanceof Error ? error.message : 'Invalid key sequence.',
          cause: error,
        });
      }

      pty.write(encoded);
      lastActivityAt = Date.now();
      await eventLog.append('input_keys', { keys });
      return {};
    },
    resize: async (params: unknown) => {
      const { cols, rows } = params as ResizeParams;

      if (!isSessionRunning(state)) {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Session is not running.',
        });
      }

      invariant(
        Number.isInteger(cols) && cols > 0,
        'cols must be a positive integer',
      );
      invariant(
        Number.isInteger(rows) && rows > 0,
        'rows must be a positive integer',
      );

      pty.resize(cols, rows);
      lastActivityAt = Date.now();
      state.setDimensions(cols, rows);
      await writeManifest(mPath, state.snapshot());
      await eventLog.append('resize', { cols, rows });
      return { cols, rows };
    },
    signal: async (params: unknown) => {
      const { signal } = params as SignalParams;

      if (!isSessionRunning(state)) {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Session is not running.',
        });
      }

      invariant(
        typeof signal === 'string' && signal.length > 0,
        'signal must be a non-empty string',
      );

      if (
        !ALLOWED_SIGNALS.includes(signal as (typeof ALLOWED_SIGNALS)[number])
      ) {
        throw makeCliError(ERROR_CODES.INVALID_SIGNAL, {
          message: `Invalid signal: ${signal}. Allowed: ${ALLOWED_SIGNALS.join(', ')}`,
          details: { signal, allowed: [...ALLOWED_SIGNALS] },
        });
      }

      const childPid = state.snapshot().childPid;
      invariant(
        childPid !== null && childPid > 0,
        'child PID must be set for signal delivery',
      );

      try {
        process.kill(childPid, 0);
      } catch {
        throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
          message: 'Child process is no longer running.',
          details: { childPid },
        });
      }

      process.kill(childPid, signal as (typeof ALLOWED_SIGNALS)[number]);

      await eventLog.append('signal', { signal });
      return {};
    },
    wait: async (params: unknown) => {
      const { exit, idleMs, timeoutMs } = params as WaitParams;
      const hasExit = exit === true;
      const hasIdle = idleMs !== undefined;

      if (hasExit === hasIdle) {
        throw makeCliError(ERROR_CODES.INVALID_DURATION, {
          message: 'Specify exactly one of exit or idleMs.',
        });
      }

      if (hasIdle) {
        invariant(
          Number.isInteger(idleMs) && idleMs > 0,
          'idleMs must be a positive integer',
        );
      }
      if (timeoutMs !== undefined) {
        invariant(
          Number.isInteger(timeoutMs) && timeoutMs > 0,
          'timeoutMs must be a positive integer',
        );
      }

      let waitCondition: Promise<WaitOutcome>;
      let clearWaitCondition: (() => void) | null = null;

      if (hasExit) {
        if (ptyHasExited) {
          const snapshot = state.snapshot();
          const result: WaitOutcome = { timedOut: false };
          if (snapshot.exitCode !== null) {
            result.exitCode = snapshot.exitCode;
          }
          return result;
        }

        waitCondition = ptyExitPromise.then(() => {
          const snapshot = state.snapshot();
          const result: WaitOutcome = { timedOut: false };
          if (snapshot.exitCode !== null) {
            result.exitCode = snapshot.exitCode;
          }
          return result;
        });
      } else {
        if (!isSessionRunning(state)) {
          throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
            message: 'Session is not running.',
          });
        }

        const idleDuration = idleMs ?? 0;
        invariant(
          Number.isInteger(idleDuration) && idleDuration > 0,
          'idleMs must be a positive integer',
        );

        const idleAnchor = Date.now();
        waitCondition = new Promise<WaitOutcome>((resolve) => {
          const checkInterval = setInterval(
            () => {
              const effectiveLastOutput = Math.max(lastOutputAt, idleAnchor);
              const elapsed = Date.now() - effectiveLastOutput;
              if (elapsed < idleDuration) {
                return;
              }

              clearInterval(checkInterval);
              const snapshot = state.snapshot();
              const result: WaitOutcome = { timedOut: false };
              if (snapshot.exitCode !== null) {
                result.exitCode = snapshot.exitCode;
              }
              resolve(result);
            },
            Math.min(idleDuration / 2, 100),
          );

          clearWaitCondition = (): void => {
            clearInterval(checkInterval);
          };
        });
      }

      if (timeoutMs === undefined) {
        return await waitCondition;
      }

      return await new Promise<WaitOutcome>((resolve) => {
        const timeoutHandle = setTimeout(() => {
          clearWaitCondition?.();
          resolve({ timedOut: true });
        }, timeoutMs);

        void waitCondition.then((result) => {
          clearTimeout(timeoutHandle);
          clearWaitCondition?.();
          resolve(result);
        });
      });
    },
    waitForRender: async (params: unknown) => {
      const { text, regex, screenStableMs, cursorRow, cursorCol, timeoutMs } =
        params as WaitForRenderParams;

      invariant(
        text !== undefined ||
          regex !== undefined ||
          screenStableMs !== undefined ||
          cursorRow !== undefined ||
          cursorCol !== undefined,
        'waitForRender requires at least one of text, regex, screenStableMs, cursorRow, or cursorCol',
      );
      invariant(
        !(text !== undefined && regex !== undefined),
        'waitForRender text and regex filters are mutually exclusive',
      );
      if (screenStableMs !== undefined) {
        invariant(
          Number.isInteger(screenStableMs) && screenStableMs > 0,
          'screenStableMs must be a positive integer',
        );
      }
      if (cursorRow !== undefined) {
        invariant(
          Number.isInteger(cursorRow) && cursorRow >= 0,
          'cursorRow must be a non-negative integer',
        );
      }
      if (cursorCol !== undefined) {
        invariant(
          Number.isInteger(cursorCol) && cursorCol >= 0,
          'cursorCol must be a non-negative integer',
        );
      }
      if (timeoutMs !== undefined) {
        invariant(
          Number.isInteger(timeoutMs) && timeoutMs > 0,
          'timeoutMs must be a positive integer',
        );
      }

      let compiledRegex: RegExp | undefined;
      if (regex !== undefined) {
        invariant(
          regex.length <= MAX_WAIT_FOR_RENDER_REGEX_LENGTH,
          `regex pattern must not exceed ${String(MAX_WAIT_FOR_RENDER_REGEX_LENGTH)} characters`,
        );
        if (hasNestedQuantifiers(regex)) {
          throw makeCliError(ERROR_CODES.INVALID_INPUT, {
            message:
              'Regex pattern contains nested quantifiers which may cause catastrophic backtracking. Simplify the pattern.',
          });
        }
        try {
          compiledRegex = new RegExp(regex);
        } catch (error) {
          throw makeCliError(ERROR_CODES.INVALID_INPUT, {
            message: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        }
      }

      const profile = resolveProfile(DEFAULT_RENDER_PROFILE_NAME);
      const pollIntervalMs = 200;
      let lastVisibleText: string | undefined;
      let lastTextChangeAt = Date.now();
      let latestCapturedAtSeq = 0;
      let clearWaitPoll: (() => void) | null = null;

      const pollCondition = new Promise<WaitForRenderResult>((resolve) => {
        let pollInFlight = false;
        let consecutiveFailures = 0;

        const checkInterval = setInterval(() => {
          if (pollInFlight) {
            return;
          }

          pollInFlight = true;
          void (async () => {
            try {
              const replayInput = loadReplayInput();
              const backend = await rendererManager.getBackend(
                profile,
                replayInput,
              );
              const snapshot = await backend.snapshot();
              const visibleText = snapshot.visibleLines
                .map((line) => line.text)
                .join('\n');
              const capturedAtSeq = snapshot.capturedAtSeq;
              latestCapturedAtSeq = capturedAtSeq;
              consecutiveFailures = 0;

              const now = Date.now();
              if (
                lastVisibleText === undefined ||
                visibleText !== lastVisibleText
              ) {
                lastVisibleText = visibleText;
                lastTextChangeAt = now;
              }

              let textMatched = false;
              let matchedText: string | undefined;
              if (text !== undefined) {
                if (visibleText.includes(text)) {
                  textMatched = true;
                  matchedText = text;
                }
              } else if (compiledRegex !== undefined) {
                const match = safeRegexExec(compiledRegex, visibleText);
                if (match !== null) {
                  textMatched = true;
                  matchedText = match[0];
                }
              } else {
                textMatched = true;
              }

              let stableMatched = true;
              if (screenStableMs !== undefined) {
                stableMatched = now - lastTextChangeAt >= screenStableMs;
              }

              const cursorMatched =
                (cursorRow === undefined || snapshot.cursorRow === cursorRow) &&
                (cursorCol === undefined || snapshot.cursorCol === cursorCol);

              if (textMatched && stableMatched && cursorMatched) {
                clearInterval(checkInterval);
                resolve({
                  matched: true,
                  timedOut: false,
                  ...(matchedText === undefined ? {} : { matchedText }),
                  cursorRow: snapshot.cursorRow,
                  cursorCol: snapshot.cursorCol,
                  capturedAtSeq,
                });
              }
            } catch (pollError) {
              void pollError;
              consecutiveFailures += 1;
              if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                clearInterval(checkInterval);
                resolve({
                  matched: false,
                  timedOut: true,
                  capturedAtSeq: latestCapturedAtSeq,
                });
                return;
              }
              // Transient — retry on next poll.
            } finally {
              pollInFlight = false;
            }
          })();
        }, pollIntervalMs);

        clearWaitPoll = (): void => {
          clearInterval(checkInterval);
        };
      });

      if (timeoutMs === undefined) {
        return await pollCondition;
      }

      return await new Promise<WaitForRenderResult>((resolve) => {
        let resolved = false;
        const timeoutHandle = setTimeout(() => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearWaitPoll?.();

          try {
            const replayInput = loadReplayInput();
            latestCapturedAtSeq = replayInput?.targetSeq ?? 0;
          } catch {
            // Best-effort snapshot for timeout reporting.
          }

          resolve({
            matched: false,
            timedOut: true,
            capturedAtSeq: latestCapturedAtSeq,
          });
        }, timeoutMs);

        void pollCondition.then((result) => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeoutHandle);
          clearWaitPoll?.();
          resolve(result);
        });
      });
    },
    destroy: () => {
      startShutdown();
      return Promise.resolve({});
    },
  };
  const rpcServer = new RpcServer(sPath, handlers);

  pty.onData((data: string) => {
    lastOutputAt = Date.now();
    lastActivityAt = lastOutputAt;
    void eventLog.append('output', { data }).catch(() => {
      // Best-effort logging; shutdown should not fail on transient append errors.
    });
  });

  pty.onExit(({ exitCode, signal }) => {
    handlePtyExit(exitCode, signal ?? null);
  });

  startIdlePolling();

  process.on('SIGTERM', () => {
    startShutdown();
  });

  try {
    await writeManifest(mPath, state.snapshot());

    if (!isSessionRunning(state)) {
      await initiateShutdown();
      return;
    }

    rpcListenPromise = rpcServer.listen();
    await rpcListenPromise;

    if (!isSessionRunning(state)) {
      await initiateShutdown();
    }
  } catch (error) {
    await initiateShutdown().catch(() => undefined);
    throw error;
  }
}
