import process from 'node:process';

import { EventLog } from './eventLog.js';
import { RpcServer, type MethodHandler } from './rpcServer.js';
import { SessionState } from './sessionState.js';
import { createPty } from '../pty/createPty.js';
import { readManifest, writeManifest } from '../storage/manifests.js';
import { resolveHome } from '../storage/home.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../storage/sessionPaths.js';
import { invariant } from '../util/assert.js';

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
  invariant(typeof sessionId === 'string' && sessionId.length > 0, 'sessionId must be a non-empty string');

  const home = resolveHome();
  const sessDir = sessionDir(home, sessionId);
  const mPath = manifestPath(sessDir);
  const ePath = eventLogPath(sessDir);
  const sPath = socketPath(sessDir);

  const manifest = await readManifest(mPath);
  invariant(manifest.sessionId === sessionId, 'session manifest sessionId must match the requested session');

  const state = new SessionState(manifest);
  invariant(Number.isInteger(process.pid) && process.pid > 0, 'process.pid must be a positive integer');
  state.setHostPid(process.pid);

  const eventLog = await EventLog.open(ePath);

  let eventLogClosed = false;
  let ptyExitHandled = false;
  let ptyHasExited = false;
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

  invariant(Number.isInteger(pty.pid) && pty.pid > 0, 'PTY child PID must be a positive integer');
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
    destroy: () => {
      startShutdown();
      return Promise.resolve({});
    },
  };
  const rpcServer = new RpcServer(sPath, handlers);

  pty.onData((data: string) => {
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
