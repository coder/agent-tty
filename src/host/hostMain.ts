import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import { ulid } from 'ulid';

import { EventLog } from './eventLog.js';
import { buildReplayInput } from './replay.js';
import { HostRendererManager } from './renderer.js';
import { RpcServer, type MethodHandler } from './rpcServer.js';
import { RunCompletionCoordinator } from './runCompletionCoordinator.js';
import { SessionState } from './sessionState.js';
import { createPty } from '../pty/createPty.js';
import { encodeKey } from '../pty/keyEncoder.js';
import { encodePaste } from '../pty/pasteEncoder.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { isCommandableSessionStatus } from '../protocol/sessionStatusPolicy.js';
import type {
  MarkParams,
  PasteParams,
  ResizeParams,
  RunParams,
  RunResult,
  ScreenshotParams,
  SendKeysParams,
  SignalParams,
  SnapshotParams,
  TypeParams,
  WaitForRenderParams,
  WaitForRenderResult,
  WaitParams,
} from '../protocol/messages.js';
import {
  DEFAULT_RENDERER_NAME,
  resolveRendererName,
  type RendererName,
} from '../renderer/names.js';
import { resolveProfile } from '../renderer/profiles.js';
import { createRendererBackend } from '../renderer/registry.js';
import { captureSnapshotResult } from '../snapshot/capture.js';
import {
  appendArtifact,
  createArtifactEntry,
} from '../storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
  screenshotFilename,
} from '../storage/artifactPaths.js';
import { resolveHome } from '../storage/home.js';
import { readManifest, writeManifest } from '../storage/manifests.js';
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

function isSessionCommandable(state: SessionState): boolean {
  return isCommandableSessionStatus(state.snapshot().status);
}

function assertSessionCommandable(state: SessionState): void {
  if (!isSessionCommandable(state)) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      // Preserve the legacy RPC wire contract: errors include only code and
      // message, so this host-side guard remains message-only.
      message: 'Session is not running.',
    });
  }
}

function rethrowAsync(error: unknown): void {
  process.nextTick(() => {
    throw error;
  });
}

function resolveHostRendererName(input: string | undefined): RendererName {
  try {
    return resolveRendererName(
      input ?? process.env.AGENT_TTY_RENDERER ?? DEFAULT_RENDERER_NAME,
    );
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Renderer must be one of: ghostty-web, libghostty-vt.',
      details: { renderer: input ?? process.env.AGENT_TTY_RENDERER },
      cause: error,
    });
  }
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
    backendFactory: (rendererName, sid, profile) =>
      createRendererBackend(rendererName, sid, profile),
  });

  const loadReplayInput = (targetSeq?: number) => {
    const events = [...eventLog.getEvents()];
    const replayInput = buildReplayInput(
      sessionId,
      state.snapshot(),
      events,
      targetSeq,
    );
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

  const runCompletion = new RunCompletionCoordinator({
    appendOutput: async (data) => {
      await eventLog.append('output', { data });
    },
    appendRunComplete: (payload) => eventLog.append('run_complete', payload),
  });
  let ptyIngestionQueue: Promise<void> = Promise.resolve();

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

  const replayRendererThroughSeq = async (targetSeq: number): Promise<void> => {
    invariant(
      Number.isInteger(targetSeq) && targetSeq >= 0,
      'targetSeq must be a non-negative integer',
    );

    const replayInput = loadReplayInput(targetSeq);
    invariant(replayInput !== null, 'run-complete replay input must exist');

    const rendererName = resolveHostRendererName(undefined);
    const profile = resolveProfile(DEFAULT_RENDER_PROFILE_NAME);
    const backend = await rendererManager.getBackend(
      rendererName,
      profile,
      replayInput,
    );
    const snapshot = await backend.snapshot();
    invariant(
      snapshot.capturedAtSeq >= targetSeq,
      'renderer snapshot must include the run-complete event sequence',
    );
  };

  const enqueuePtyIngestion = (
    operation: () => Promise<void>,
  ): Promise<void> => {
    const queuedOperation = ptyIngestionQueue.then(operation, operation);
    ptyIngestionQueue = queuedOperation.catch(() => undefined);
    return queuedOperation;
  };

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
      !isSessionCommandable(state) ||
      idleTimeoutHandle !== null
    ) {
      return;
    }

    const checkIntervalMs = Math.min(idleTimeoutMs, IDLE_CHECK_CAP_MS);
    idleTimeoutHandle = setInterval(() => {
      if (!isSessionCommandable(state)) {
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
        if (isSessionCommandable(state)) {
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
        runCompletion.resolvePendingWaitersForExit();
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
        rendererName: requestedRendererName,
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

      const rendererName = resolveHostRendererName(requestedRendererName);
      const profile = resolveProfile(DEFAULT_RENDER_PROFILE_NAME);
      const replayInput = loadReplayInput();
      const backend = await rendererManager.getBackend(
        rendererName,
        profile,
        replayInput,
      );
      const snapshot = await backend.snapshot({
        includeScrollback,
        includeCells,
      });
      return await captureSnapshotResult({
        sessionDir: sessDir,
        format,
        snapshot,
        rendererBackend: backend.rendererBackend,
        expectedSessionId: sessionId,
      });
    },
    screenshot: async (params: unknown) => {
      const {
        profile: requestedProfileName,
        rendererName: requestedRendererName,
        showCursor,
      } = params as ScreenshotParams;

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

      const rendererName = resolveHostRendererName(requestedRendererName);
      const replayInput = loadReplayInput();
      const backend = await rendererManager.getBackend(
        rendererName,
        profile,
        replayInput,
      );
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

      assertSessionCommandable(state);

      invariant(typeof text === 'string', 'type text must be a string');
      pty.write(text);
      lastActivityAt = Date.now();
      await eventLog.append('input_text', { data: text });
      return {};
    },
    mark: async (params: unknown) => {
      const { label } = params as MarkParams;

      assertSessionCommandable(state);

      invariant(typeof label === 'string', 'mark label must be a string');
      lastActivityAt = Date.now();
      const seq = await eventLog.append('marker', { label });
      return { seq };
    },
    paste: async (params: unknown) => {
      const { text } = params as PasteParams;

      assertSessionCommandable(state);

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
    run: async (params: unknown) => {
      const { command, noWait, timeoutMs } = params as RunParams;

      assertSessionCommandable(state);

      invariant(
        typeof command === 'string' && command.length > 0,
        'run command must be a non-empty string',
      );
      if (timeoutMs !== undefined) {
        invariant(
          Number.isInteger(timeoutMs) && timeoutMs > 0,
          'run timeoutMs must be a positive integer',
        );
      }

      const shouldWait = !noWait;

      if (!shouldWait) {
        pty.write(`${command}\n`);
        lastActivityAt = Date.now();

        const seq = await eventLog.append('input_run', {
          command,
          noWait,
        });

        return {
          accepted: true as const,
          seq,
        } satisfies RunResult;
      }

      const preparedRun = runCompletion.prepareWaitedRun();
      const seq = await eventLog.append('input_run', {
        command,
        marker: preparedRun.marker,
        noWait,
      });
      const completion = runCompletion.registerWaitedRun({
        marker: preparedRun.marker,
        inputRunSeq: seq,
      });
      const injectedText = `${command}\n${completion.postamble}`;
      const effectiveTimeoutMs = timeoutMs ?? 30_000;
      const startTime = Date.now();
      pty.write(injectedText);
      lastActivityAt = Date.now();

      const waitResult = await completion.wait(effectiveTimeoutMs);
      const durationMs = Date.now() - startTime;

      if (waitResult.kind === 'completed') {
        try {
          await replayRendererThroughSeq(waitResult.seq);
        } catch {
          // The run already completed and was committed to the event log. Do not
          // turn a best-effort renderer catch-up failure into a command retry
          // hazard; replay-driven snapshots can catch up on the next request.
        }
      }

      return {
        accepted: true as const,
        completed: waitResult.kind === 'completed',
        timedOut: waitResult.kind === 'timeout',
        seq,
        durationMs,
        marker: preparedRun.marker,
      } satisfies RunResult;
    },
    sendKeys: async (params: unknown) => {
      const { keys } = params as SendKeysParams;

      assertSessionCommandable(state);

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

      // pty.write() queues bytes into the kernel buffer synchronously.
      // We record the event log entry after the write so that seq reflects
      // a committed write. If eventLog.append() rejects, the event is
      // rolled back and the RPC returns an error — the PTY received the
      // bytes but the client can retry or inspect the session state.
      pty.write(encoded);
      lastActivityAt = Date.now();

      let seq: number;
      try {
        seq = await eventLog.append('input_keys', { keys: [...keys] });
      } catch (error) {
        // PTY received input but event log write failed — client gets RPC error.
        // Log for debugging since the partial-write state is non-obvious.
        console.debug(
          'sendKeys: eventLog.append failed after pty.write:',
          error,
        );
        throw error;
      }
      return {
        accepted: [...keys],
        bytesWritten: Buffer.byteLength(encoded),
        seq,
      };
    },
    resize: async (params: unknown) => {
      const { cols, rows } = params as ResizeParams;

      assertSessionCommandable(state);

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

      assertSessionCommandable(state);

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
        assertSessionCommandable(state);

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
      const {
        text,
        regex,
        screenStableMs,
        cursorRow,
        cursorCol,
        timeoutMs,
        rendererName: requestedRendererName,
      } = params as WaitForRenderParams;

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

      const rendererName = resolveHostRendererName(requestedRendererName);
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
                rendererName,
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
      return Promise.resolve({
        sessionId,
        destroyed: true,
      });
    },
  };
  const rpcServer = new RpcServer(sPath, handlers);

  pty.onData((data: string) => {
    lastOutputAt = Date.now();
    // PTY output counts as session activity for idle-timeout purposes.
    // A session actively producing output (e.g., a running build, log tail)
    // is "in use" and should not be killed for inactivity.
    lastActivityAt = lastOutputAt;
    void enqueuePtyIngestion(async () => {
      await runCompletion.ingestPtyData(data);
    }).catch((error: unknown) => {
      // Run-completion sentinels make serialized PTY ingestion part of the
      // canonical event-log contract: if appending output/control events fails,
      // the log can no longer be trusted to drive waits or replay artifacts.
      rethrowAsync(error);
    });
  });

  pty.onExit(({ exitCode, signal }) => {
    let ingestionError: unknown;

    void enqueuePtyIngestion(async () => {
      await runCompletion.flushPtyDataOnExit();
    })
      .catch((error: unknown) => {
        ingestionError = error;
      })
      .finally(() => {
        try {
          handlePtyExit(exitCode, signal ?? null);
        } finally {
          if (ingestionError !== undefined) {
            // Still record PTY exit state first; the ingestion failure is
            // surfaced asynchronously after exit handling has run.
            rethrowAsync(ingestionError);
          }
        }
      })
      .catch(rethrowAsync);
  });

  startIdlePolling();

  process.on('SIGTERM', () => {
    startShutdown();
  });

  try {
    await writeManifest(mPath, state.snapshot());
    await mkdir(dirname(sPath), { recursive: true });

    if (!isSessionCommandable(state)) {
      await initiateShutdown();
      return;
    }

    rpcListenPromise = rpcServer.listen();
    await rpcListenPromise;

    if (!isSessionCommandable(state)) {
      await initiateShutdown();
    }
  } catch (error) {
    await initiateShutdown().catch(() => undefined);
    throw error;
  }
}
