import { listSessions } from '../host/lifecycle.js';
import { readManifestIfExists } from '../storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
} from '../storage/sessionPaths.js';

/**
 * The Session Dashboard list scope.
 *
 * - `active`: **Active Sessions** only (mirrors `list`).
 * - `all`: **Active** plus **Terminal** Sessions, excluding `destroyed` (a
 *   **Collectable Session** whose **Event Log** may already be removed).
 */
export type DashboardScope = 'active' | 'all';

export interface DashboardSession {
  sessionId: string;
  status: string;
  command: string[];
  createdAt: string;
  name?: string;
  /** Replay dimensions used to seed Event Log Follow (creation size). */
  initialCols: number;
  initialRows: number;
  eventLog: string;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** List the Sessions a Dashboard should show for a scope, newest-first. */
export async function listDashboardSessions(
  home: string,
  scope: DashboardScope,
): Promise<DashboardSession[]> {
  const summaries = await listSessions(home, scope === 'all');
  const visible =
    scope === 'all'
      ? summaries.filter((summary) => summary.status !== 'destroyed')
      : summaries;

  const sessions: DashboardSession[] = [];
  for (const summary of visible) {
    const dir = sessionDir(home, summary.sessionId);
    const manifest = await readManifestIfExists(manifestPath(dir));
    sessions.push({
      sessionId: summary.sessionId,
      status: summary.status,
      command: summary.command,
      createdAt: summary.createdAt,
      ...(summary.name === undefined ? {} : { name: summary.name }),
      initialCols: manifest?.creationCols ?? manifest?.cols ?? DEFAULT_COLS,
      initialRows: manifest?.creationRows ?? manifest?.rows ?? DEFAULT_ROWS,
      eventLog: eventLogPath(dir),
    });
  }

  sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sessions;
}
