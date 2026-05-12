import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import {
  matchRenderWaitSnapshot,
  prepareRenderWaitCondition,
} from '../renderWait/matcher.js';
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
import { captureScreenshotResult } from '../screenshot/capture.js';
import { captureSnapshotResult } from '../snapshot/capture.js';
import { resolveHome } from '../storage/home.js';
import { readManifest, writeManifest } from '../storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../storage/sessionPaths.js';
import {
  addAbortListener,
  makeAbortReason,
  throwIfAborted,
  waitForScopedOperation,
} from '../util/abort.js';
import { invariant } from '../util/assert.js';
import { ResourceScope } from '../util/resourceScope.js';

const ALLOWED_SIGNALS = [
  'SIGTERM',
  'SIGINT',
  'SIGKILL',
  'SIGHUP',
  'SIGUSR1',
  'SIGUSR2',
] as const;

const DEFAULT_RENDER_PROFILE_NAME = 'reference-dark';
export const MAX_CONSECUTIVE_POLL_FAILURES = 10;
// Idle-timeout enforcement is polling-based: actual idle duration before kill
// may exceed idleTimeoutMs by up to checkIntervalMs (bounded by this cap).
const IDLE_CHECK_CAP_MS = 5_000;

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
  const hostAbortController = new AbortController();
  let idleTimeoutScope: ResourceScope | null = null;
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

  // Per-client wait-exit callbacks, cleaned up individually via ResourceScope.
  // Using ptyExitPromise.then() would permanently attach to the shared promise.
  const ptyExitWaiters = new Set<() => void>();

  const ptyExitPromise = new Promise<void>((resolve) => {
    markPtyExited = (): void => {
      if (ptyHasExited) {
        return;
      }

      ptyHasExited = true;
      resolve();
      const waiters = [...ptyExitWaiters];
      ptyExitWaiters.clear();
      for (const waiter of waiters) {
        waiter();
      }
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

  // PTY ingestion recovers after a failure: the .then(operation, operation)
  // shape runs the next queued operation regardless of whether the
  // predecessor fulfilled or rejected, and the chain is resumed with
  // .catch(() => undefined) so subsequent ingestion work is not gated on
  // past rejections. Do not refactor this into a generic per-key
  // serializer that cascades rejections - that would silently drop later
  // PTY data after a single ingestion error.
  const enqueuePtyIngestion = (
    operation: () => Promise<void>,
  ): Promise<void> => {
    const queuedOperation = ptyIngestionQueue.then(operation, operation);
    ptyIngestionQueue = queuedOperation.catch(() => undefined);
    return queuedOperation;
  };

  const clearIdleTimeout = (): void => {
    // Idempotent: safe to call multiple times during shutdown and PTY exit.
    const scope = idleTimeoutScope;
    idleTimeoutScope = null;
    if (scope === null) {
      return;
    }

    void scope.close().catch(rethrowAsync);
  };

  const startIdlePolling = (): void => {
    if (
      idleTimeoutMs <= 0 ||
      !isSessionCommandable(state) ||
      idleTimeoutScope !== null
    ) {
      return;
    }

    throwIfAborted(hostAbortController.signal);

    const scope = new ResourceScope();
    idleTimeoutScope = scope;
    const checkIntervalMs = Math.min(idleTimeoutMs, IDLE_CHECK_CAP_MS);
    let idleTimeoutHandle: ReturnType<typeof setInterval> | null = null;
    idleTimeoutHandle = setInterval(() => {
      if (hostAbortController.signal.aborted) {
        clearIdleTimeout();
        return;
      }

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
    scope.add('idle timeout interval', () => {
      if (idleTimeoutHandle !== null) {
        clearInterval(idleTimeoutHandle);
        idleTimeoutHandle = null;
      }
    });
    addAbortListener(
      scope,
      'idle timeout abort listener',
      hostAbortController.signal,
      () => {
        clearIdleTimeout();
      },
    );
  };

  const initiateShutdown = (): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      try {
        hostAbortController.abort(makeAbortReason('Host is shutting down.'));
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
        runCompletion.resetForExit();
        try {
          await writeManifest(mPath, state.snapshot());
        } finally {
          await initiateShutdown();
        }
      }
    })().catch(rethrowAsync);
  };

  const makeWaitExitOutcome = (): WaitOutcome => {
    const snapshot = state.snapshot();
    const result: WaitOutcome = { timedOut: false };
    if (snapshot.exitCode !== null) {
      result.exitCode = snapshot.exitCode;
    }
    return result;
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

      return await captureScreenshotResult({
        backend,
        sessionDir: sessDir,
        profileName: profile.name,
        expectedSessionId: sessionId,
        ...(showCursor === undefined ? {} : { showCursor }),
      });
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
    run: async (params: unknown, context) => {
      const { command, noWait, timeoutMs } = params as RunParams;
      const { signal } = context;

      throwIfAborted(signal);
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

      const waitResult = await completion.wait(effectiveTimeoutMs, { signal });
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
    wait: async (params: unknown, context) => {
      const { exit, idleMs, timeoutMs } = params as WaitParams;
      const { signal } = context;
      const hasExit = exit === true;
      const hasIdle = idleMs !== undefined;

      throwIfAborted(signal);
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

      const waitScope = new ResourceScope();
      let waitCondition: Promise<WaitOutcome>;

      if (hasExit) {
        if (ptyHasExited) {
          return makeWaitExitOutcome();
        }

        waitCondition = new Promise<WaitOutcome>((resolve) => {
          const waiter = (): void => {
            resolve(makeWaitExitOutcome());
          };
          ptyExitWaiters.add(waiter);
          waitScope.add('wait exit waiter', () => {
            ptyExitWaiters.delete(waiter);
          });
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
              if (signal.aborted) {
                return;
              }

              const effectiveLastOutput = Math.max(lastOutputAt, idleAnchor);
              const elapsed = Date.now() - effectiveLastOutput;
              if (elapsed < idleDuration) {
                return;
              }

              const snapshot = state.snapshot();
              const result: WaitOutcome = { timedOut: false };
              if (snapshot.exitCode !== null) {
                result.exitCode = snapshot.exitCode;
              }
              resolve(result);
            },
            Math.min(idleDuration / 2, 100),
          );

          waitScope.add('wait idle poll interval', () => {
            clearInterval(checkInterval);
          });
        });
      }

      return await waitForScopedOperation({
        operationName: 'wait',
        operation: waitCondition,
        scope: waitScope,
        signal,
        ...(timeoutMs === undefined
          ? {}
          : {
              timeoutMs,
              timeoutResult: () => ({ timedOut: true }),
            }),
      });
    },
    waitForRender: async (params: unknown, context) => {
      const {
        text,
        regex,
        screenStableMs,
        cursorRow,
        cursorCol,
        timeoutMs,
        rendererName: requestedRendererName,
      } = params as WaitForRenderParams;
      const { signal } = context;

      throwIfAborted(signal);
      const preparedCondition = prepareRenderWaitCondition({
        text,
        regex,
        screenStableMs,
        cursorRow,
        cursorCol,
      });
      if (timeoutMs !== undefined) {
        invariant(
          Number.isInteger(timeoutMs) && timeoutMs > 0,
          'timeoutMs must be a positive integer',
        );
      }

      const rendererName = resolveHostRendererName(requestedRendererName);
      const profile = resolveProfile(DEFAULT_RENDER_PROFILE_NAME);
      const pollIntervalMs = 200;
      const waitScope = new ResourceScope();
      let lastVisibleText: string | undefined;
      let lastTextChangeAt = Date.now();
      let latestCapturedAtSeq = 0;

      const pollCondition = new Promise<WaitForRenderResult>((resolve) => {
        let pollInFlight = false;
        let consecutiveFailures = 0;

        const checkInterval = setInterval(() => {
          if (signal.aborted || pollInFlight) {
            return;
          }

          pollInFlight = true;
          void (async () => {
            try {
              throwIfAborted(signal);
              const replayInput = loadReplayInput();
              const backend = await rendererManager.getBackend(
                rendererName,
                profile,
                replayInput,
              );
              throwIfAborted(signal);
              const snapshot = await backend.snapshot();
              throwIfAborted(signal);
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

              const match = matchRenderWaitSnapshot(
                preparedCondition,
                snapshot,
                {
                  stableForMs: now - lastTextChangeAt,
                },
              );

              if (match.matched) {
                resolve({
                  matched: true,
                  timedOut: false,
                  ...(match.matchedText === undefined
                    ? {}
                    : { matchedText: match.matchedText }),
                  cursorRow: match.cursorRow,
                  cursorCol: match.cursorCol,
                  capturedAtSeq,
                });
              }
            } catch (pollError) {
              if (signal.aborted) {
                return;
              }

              void pollError;
              consecutiveFailures += 1;
              if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
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

        waitScope.add('waitForRender poll interval', () => {
          clearInterval(checkInterval);
        });
      });

      return await waitForScopedOperation({
        operationName: 'waitForRender',
        operation: pollCondition,
        scope: waitScope,
        signal,
        ...(timeoutMs === undefined
          ? {}
          : {
              timeoutMs,
              timeoutResult: () => {
                try {
                  const replayInput = loadReplayInput();
                  latestCapturedAtSeq = replayInput?.targetSeq ?? 0;
                } catch {
                  // Best-effort snapshot for timeout reporting.
                }

                return {
                  matched: false,
                  timedOut: true,
                  capturedAtSeq: latestCapturedAtSeq,
                };
              },
            }),
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
