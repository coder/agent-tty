import process from 'node:process';

import { EventLog } from './eventLog.js';
import { RpcServer, type MethodHandler } from './rpcServer.js';
import { SessionState } from './sessionState.js';
import { createPty } from '../pty/createPty.js';
import { encodeKey } from '../pty/keyEncoder.js';
import { encodePaste } from '../pty/pasteEncoder.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import type {
  PasteParams,
  ResizeParams,
  SendKeysParams,
  SignalParams,
  TypeParams,
  WaitParams,
} from '../protocol/messages.js';
import { readManifest, writeManifest } from '../storage/manifests.js';
import { resolveHome } from '../storage/home.js';
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
      return {};
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

        waitCondition = new Promise<WaitOutcome>((resolve) => {
          const checkInterval = setInterval(
            () => {
              const elapsed = Date.now() - lastOutputAt;
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
