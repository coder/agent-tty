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

  const loadReplayInput = async () => {
    const events = [...eventLog.getEvents()];
    const replayInput = buildReplayInput(sessionId, state.snapshot(), events);
    return replayInput.targetSeq === -1 ? null : replayInput;
  };

  let eventLogClosed = false;
  let ptyExitHandled = false;
  let ptyHasExited = false;
  let lastOutputAt = Date.now();
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
  });

  invariant(
    Number.isInteger(pty.pid) && pty.pid > 0,
    'PTY child PID must be a positive integer',
  );
  state.setChildPid(pty.pid);

  const initiateShutdown = (): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      try {
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

    const exitSignal = normalizeExitSignal(signal);
    state.recordExit(exitCode, exitSignal);
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
      const { format: requestedFormat } = params as SnapshotParams;

      const format = requestedFormat ?? 'structured';

      const profile = resolveProfile(DEFAULT_RENDER_PROFILE_NAME);
      const replayInput = await loadReplayInput();
      const backend = await rendererManager.getBackend(profile, replayInput);
      const snapshot = await backend.snapshot();

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
              text: snapshot.visibleLines.map((line) => line.text).join('\n'),
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
            cols: snapshot.cols,
            rows: snapshot.rows,
            cursorRow: snapshot.cursorRow,
            cursorCol: snapshot.cursorCol,
          },
        }),
      );

      return snapshotResult;
    },
    screenshot: async (params: unknown) => {
      const { profile: requestedProfileName } = params as ScreenshotParams;

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

      const replayInput = await loadReplayInput();
      const backend = await rendererManager.getBackend(profile, replayInput);
      await ensureArtifactsDir(sessDir);
      const temporaryOutputPath = artifactPath(
        sessDir,
        `.tmp-screenshot-${ulid()}.png`,
      );

      try {
        const result = await backend.screenshot(temporaryOutputPath);

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
            metadata: {
              profileName: result.profileName,
              cols: result.cols,
              rows: result.rows,
              pngSizeBytes: result.pngSizeBytes,
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
      await eventLog.append('input_text', { data: text });
      return {};
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
      const { text, regex, screenStableMs, timeoutMs } =
        params as WaitForRenderParams;

      invariant(
        text !== undefined ||
          regex !== undefined ||
          screenStableMs !== undefined,
        'waitForRender requires at least one of text, regex, or screenStableMs',
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
      if (timeoutMs !== undefined) {
        invariant(
          Number.isInteger(timeoutMs) && timeoutMs > 0,
          'timeoutMs must be a positive integer',
        );
      }

      let compiledRegex: RegExp | undefined;
      if (regex !== undefined) {
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

        const checkInterval = setInterval(() => {
          if (pollInFlight) {
            return;
          }

          pollInFlight = true;
          void (async () => {
            try {
              const replayInput = await loadReplayInput();
              const backend = await rendererManager.getBackend(
                profile,
                replayInput,
              );
              const visibleText = await backend.getVisibleText();
              const capturedAtSeq = replayInput?.targetSeq ?? 0;
              latestCapturedAtSeq = capturedAtSeq;

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
                const match = compiledRegex.exec(visibleText);
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

              if (textMatched && stableMatched) {
                clearInterval(checkInterval);
                resolve({
                  matched: true,
                  timedOut: false,
                  ...(matchedText === undefined ? {} : { matchedText }),
                  capturedAtSeq,
                });
              }
            } catch {
              // Retry on the next poll; render state may still be catching up.
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
        const timeoutHandle = setTimeout(() => {
          clearWaitPoll?.();

          void (async () => {
            try {
              const replayInput = await loadReplayInput();
              latestCapturedAtSeq = replayInput?.targetSeq ?? 0;
            } catch {
              // Best-effort snapshot for timeout reporting.
            }

            resolve({
              matched: false,
              timedOut: true,
              capturedAtSeq: latestCapturedAtSeq,
            });
          })();
        }, timeoutMs);

        void pollCondition.then((result) => {
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
    void eventLog.append('output', { data }).catch(() => {
      // Best-effort logging; shutdown should not fail on transient append errors.
    });
  });

  pty.onExit(({ exitCode, signal }) => {
    handlePtyExit(exitCode, signal ?? null);
  });

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
