import type { SessionRecord } from '../protocol/schemas.js';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import { readManifestIfExists } from '../storage/manifests.js';
import {
  manifestPath as resolveManifestPath,
  sessionDir,
  socketPath as resolveSocketPath,
} from '../storage/sessionPaths.js';
import { assertSessionCommandable } from './sessionGuards.js';

export interface ResolveCommandTargetOptions {
  home: string;
  sessionId: string;
}

export type CommandTargetManifest = SessionRecord & { status: 'running' };

export interface CommandTarget {
  sessionId: string;
  sessionDirectory: string;
  manifestPath: string;
  socketPath: string;
  manifest: CommandTargetManifest;
}

function assertRunningManifest(
  manifest: SessionRecord,
): asserts manifest is CommandTargetManifest {
  invariant(
    manifest.status === 'running',
    'command target manifest must be running after commandability check',
  );
}

/**
 * Resolve the live command target for input/control commands.
 *
 * Throws SESSION_NOT_FOUND when the manifest is missing,
 * SESSION_ALREADY_DESTROYED for destroyed sessions, and SESSION_NOT_RUNNING
 * for other non-commandable statuses. This deliberately does not check that
 * the socket exists or is connectable; sendRpc() remains the host liveness
 * boundary.
 */
export async function resolveCommandTarget(
  options: ResolveCommandTargetOptions,
): Promise<CommandTarget> {
  const sessionDirectory = sessionDir(options.home, options.sessionId);
  const resolvedManifestPath = resolveManifestPath(sessionDirectory);
  const manifest = await readManifestIfExists(resolvedManifestPath);

  if (manifest === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${options.sessionId}" was not found.`,
      details: {
        sessionId: options.sessionId,
        manifestPath: resolvedManifestPath,
      },
    });
  }

  assertSessionCommandable(manifest, options.sessionId);
  assertRunningManifest(manifest);

  return {
    sessionId: options.sessionId,
    sessionDirectory,
    manifestPath: resolvedManifestPath,
    socketPath: resolveSocketPath(sessionDirectory),
    manifest,
  };
}
