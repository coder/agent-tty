import { basename, isAbsolute, resolve } from 'node:path';

import { buildReplayInput, readEventLogRecords } from '../host/replay.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import type { EventRecord, SessionRecord } from '../protocol/schemas.js';
import type { RendererBackend } from '../renderer/backend.js';
import { GhosttyWebBackend } from '../renderer/ghosttyWeb/backend.js';
import { resolveProfile } from '../renderer/profiles.js';
import type { RenderProfileConfig, ReplayInput } from '../renderer/types.js';
import { readManifestIfExists } from '../storage/manifests.js';
import { eventLogPath, manifestPath } from '../storage/sessionPaths.js';
import { invariant } from '../util/assert.js';

export interface OfflineReplayDeps {
  backendFactory?: (
    sessionId: string,
    profile: RenderProfileConfig,
  ) => RendererBackend;
}

interface OfflineReplayContext {
  manifest: SessionRecord;
  replayInput: ReplayInput;
  backend: RendererBackend;
}

interface NodeError {
  code?: string;
}

function assertAbsoluteSessionDir(sessionDir: string): string {
  invariant(sessionDir.length > 0, 'sessionDir must be a non-empty string');
  invariant(isAbsolute(sessionDir), 'sessionDir must be an absolute path');
  return resolve(sessionDir);
}

function getSessionId(sessionDir: string): string {
  const sessionId = basename(sessionDir);
  invariant(sessionId.length > 0, 'sessionDir must end with a session directory');
  return sessionId;
}

function isEnoentError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === 'ENOENT'
  );
}

function createBackend(
  sessionId: string,
  profile: RenderProfileConfig,
  deps?: OfflineReplayDeps,
): RendererBackend {
  const backendFactory =
    deps?.backendFactory ??
    ((factorySessionId: string, factoryProfile: RenderProfileConfig) =>
      new GhosttyWebBackend(factorySessionId, factoryProfile));

  invariant(
    typeof backendFactory === 'function',
    'backendFactory must be a function when provided',
  );

  return backendFactory(sessionId, profile);
}

async function readOfflineReplayInput(
  sessionDir: string,
  sessionId: string,
  manifest: SessionRecord,
  targetSeq?: number,
): Promise<ReplayInput> {
  const eventLogFile = eventLogPath(sessionDir);

  let events: EventRecord[];
  try {
    events = await readEventLogRecords(eventLogFile);
  } catch (error) {
    if (isEnoentError(error)) {
      events = [];
    } else {
      throw makeCliError(ERROR_CODES.REPLAY_ERROR, {
        message: `Failed to read event log: ${eventLogFile}`,
        cause: error,
      });
    }
  }

  try {
    return buildReplayInput(sessionId, manifest, events, targetSeq);
  } catch (error) {
    throw makeCliError(ERROR_CODES.REPLAY_ERROR, {
      message: `Failed to build replay input for session ${sessionId}.`,
      cause: error,
    });
  }
}

export async function withOfflineReplayRenderer<T>(
  options: {
    sessionDir: string;
    profileName?: string;
    targetSeq?: number;
  },
  run: (context: OfflineReplayContext) => Promise<T>,
  deps?: OfflineReplayDeps,
): Promise<T> {
  invariant(typeof run === 'function', 'run must be a function');
  const sessionDir = assertAbsoluteSessionDir(options.sessionDir);
  const sessionId = getSessionId(sessionDir);

  const manifestFile = manifestPath(sessionDir);
  const manifest = await readManifestIfExists(manifestFile);
  invariant(manifest !== null, `Session manifest does not exist at ${manifestFile}.`);

  let profile: RenderProfileConfig;
  try {
    profile = resolveProfile(options.profileName ?? 'reference-dark');
  } catch (error) {
    throw makeCliError(ERROR_CODES.REPLAY_ERROR, {
      message: `Failed to resolve render profile for session ${sessionId}.`,
      cause: error,
    });
  }

  const backend = createBackend(sessionId, profile, deps);

  try {
    const replayInput = await readOfflineReplayInput(
      sessionDir,
      sessionId,
      manifest,
      options.targetSeq,
    );

    try {
      await backend.boot();
      if (replayInput.targetSeq >= 0) {
        await backend.replayTo(replayInput);
      }
    } catch (error) {
      throw makeCliError(ERROR_CODES.REPLAY_ERROR, {
        message: `Failed to boot or replay renderer for session ${sessionId}.`,
        cause: error,
      });
    }

    return await run({ manifest, replayInput, backend });
  } finally {
    await backend.dispose();
  }
}
