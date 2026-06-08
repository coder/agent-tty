import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  isActiveSessionStatus,
  isDestroyedSessionStatus,
} from '../protocol/sessionStatusPolicy.js';
import type { SessionRecord } from '../protocol/schemas.js';
import { createHomeRegistry, type HomeRegistry } from './homeRegistry.js';
import { readManifestIfExists } from './manifests.js';
import { manifestPath, sessionDir } from './sessionPaths.js';

/**
 * Active/all scope for listing Homes. Structurally identical to the dashboard's
 * Session scope, but declared here so this neutral module — shared by the
 * `home list` CLI command and the dashboard Home picker — depends on neither
 * the CLI nor the dashboard layer.
 */
export type HomeListingScope = 'active' | 'all';

/**
 * A registered Home enriched with live, derived Session counts for display in
 * `home list` and the dashboard Home picker. The counts are never persisted.
 */
export interface RegisteredHome {
  path: string;
  activeSessions: number;
  totalSessions: number;
  lastSeenAt: string;
}

export interface HomeSessionCounts {
  activeSessions: number;
  totalSessions: number;
}

export interface ScanHomeDependencies {
  readdir: (path: string) => Promise<string[]>;
  readManifestIfExists: (path: string) => Promise<SessionRecord | null>;
}

const defaultScanDependencies: ScanHomeDependencies = {
  readdir,
  readManifestIfExists,
};

/**
 * Count a Home's visible Sessions WITHOUT reconciling.
 *
 * This is read-only by contract: it never calls `reconcileSession` and never
 * writes a manifest, so listing Homes (CLI or dashboard picker) cannot mutate
 * Session state. Active counts may therefore be momentarily stale (a dead host
 * still shows `running` until something reconciles it); entering a Home in the
 * dashboard, or running `gc`, reconciles for real.
 *
 * "Visible" excludes destroyed Sessions, mirroring the dashboard's `all` scope
 * (a destroyed Session's Event Log may already be collected). It never throws:
 * a missing/unreadable sessions tree, or a corrupt individual manifest, counts
 * as zero/skip so a single bad Session can't break discovery.
 */
export async function scanHome(
  home: string,
  dependencies: ScanHomeDependencies = defaultScanDependencies,
): Promise<HomeSessionCounts> {
  const sessionsRoot = resolve(home, 'sessions');

  let entries: string[];
  try {
    entries = await dependencies.readdir(sessionsRoot);
  } catch {
    // Missing or unreadable sessions tree → nothing observable here.
    return { activeSessions: 0, totalSessions: 0 };
  }

  let activeSessions = 0;
  let totalSessions = 0;
  for (const entry of entries) {
    let manifest: SessionRecord | null;
    try {
      manifest = await dependencies.readManifestIfExists(
        manifestPath(sessionDir(home, entry)),
      );
    } catch {
      continue;
    }

    if (manifest === null || isDestroyedSessionStatus(manifest.status)) {
      continue;
    }

    totalSessions += 1;
    if (isActiveSessionStatus(manifest.status)) {
      activeSessions += 1;
    }
  }

  return { activeSessions, totalSessions };
}

export interface ListRegisteredHomesDependencies {
  registry: Pick<HomeRegistry, 'read'>;
  scanHome: (home: string) => Promise<HomeSessionCounts>;
}

function defaultListDependencies(): ListRegisteredHomesDependencies {
  return {
    registry: createHomeRegistry(),
    scanHome: (home) => scanHome(home),
  };
}

/**
 * List registered Homes for a scope, newest-`lastSeenAt`-first. Shared by the
 * `home list` command and the dashboard Home picker so the two surfaces never
 * disagree under the same scope.
 *
 * - **prune-on-read**: a Home with zero visible Sessions (directory or
 *   `sessions/` gone, empty, or only destroyed) is omitted and never shown,
 *   regardless of scope. The registry file is not rewritten here — durable
 *   compaction (deregistration) is gc's job.
 * - `active` scope additionally requires at least one Active Session (an
 *   **Active Home**); `all` includes Homes whose Sessions are all terminal.
 */
export async function listRegisteredHomes(
  scope: HomeListingScope,
  dependencies: ListRegisteredHomesDependencies = defaultListDependencies(),
): Promise<RegisteredHome[]> {
  const entries = await dependencies.registry.read();

  const homes: RegisteredHome[] = [];
  for (const entry of entries) {
    const counts = await dependencies.scanHome(entry.path);
    if (counts.totalSessions === 0) {
      continue; // prune-on-read: nothing observable in this Home
    }
    if (scope === 'active' && counts.activeSessions === 0) {
      continue; // not an Active Home
    }
    homes.push({
      path: entry.path,
      activeSessions: counts.activeSessions,
      totalSessions: counts.totalSessions,
      lastSeenAt: entry.lastSeenAt,
    });
  }

  homes.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  return homes;
}
