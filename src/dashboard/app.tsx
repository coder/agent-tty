import { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';

import type { DashboardAppOptions } from '../cli/commands/dashboard.js';
import { createRendererBackend } from '../renderer/registry.js';
import { resolveProfile } from '../renderer/profiles.js';
import { EventLogTailSource } from './eventSource.js';
import { LiveViewFollower, type LiveViewFrame } from './liveViewFollower.js';
import {
  projectLiveView,
  type LiveViewMode,
  type PanOffset,
  type ProjectedCell,
  type ProjectedView,
} from './liveViewProjection.js';
import {
  listDashboardSessions,
  type DashboardScope,
  type DashboardSession,
} from './sessionScope.js';

// reference-dark profile defaults; cells matching these are left unstyled so the
// terminal's own theme shows through instead of repainting every cell.
const PROFILE_BG = '#1e1e2e';
const PROFILE_FG = '#cdd6f4';
const LIST_WIDTH = 28;
const FRAME_INTERVAL_MS = 33;
const LIST_REFRESH_MS = 1500;
const PAN_STEP = 1;

type Focus = 'list' | 'live';

// ── cell-grid painting ────────────────────────────────────────────────────────

function styleKey(cell: ProjectedCell): string {
  return [
    cell.fg ?? '',
    cell.bg ?? '',
    cell.bold === true ? '1' : '0',
    cell.italic === true ? '1' : '0',
    cell.underline === true ? '1' : '0',
    cell.strikethrough === true ? '1' : '0',
    cell.cursor === true ? '1' : '0',
  ].join('|');
}

/** Coalesce a row of cells into styled runs to keep the Ink tree small. */
function paintRow(cells: ProjectedCell[], rowKey: number): React.ReactNode {
  const runs: React.ReactNode[] = [];
  let index = 0;
  let runIndex = 0;
  while (index < cells.length) {
    const cell = cells[index];
    if (cell === undefined) {
      break;
    }
    const key = styleKey(cell);
    let text = cell.char === '' ? ' ' : cell.char;
    let next = index + 1;
    while (next < cells.length) {
      const candidate = cells[next];
      if (candidate === undefined || styleKey(candidate) !== key) {
        break;
      }
      text += candidate.char === '' ? ' ' : candidate.char;
      next += 1;
    }
    const fg =
      cell.fg !== undefined && cell.fg !== PROFILE_FG ? cell.fg : undefined;
    const bg =
      cell.bg !== undefined && cell.bg !== PROFILE_BG ? cell.bg : undefined;
    runs.push(
      <Text
        key={runIndex}
        {...(fg === undefined ? {} : { color: fg })}
        {...(bg === undefined ? {} : { backgroundColor: bg })}
        bold={cell.bold === true}
        italic={cell.italic === true}
        underline={cell.underline === true}
        strikethrough={cell.strikethrough === true}
        inverse={cell.cursor === true}
      >
        {text}
      </Text>,
    );
    runIndex += 1;
    index = next;
  }
  return (
    <Text key={rowKey} wrap="truncate">
      {runs}
    </Text>
  );
}

function truncationIndicator(view: ProjectedView): string {
  const marks: string[] = [];
  if (view.truncated.top) marks.push('↑');
  if (view.truncated.bottom) marks.push('↓');
  if (view.truncated.left) marks.push('←');
  if (view.truncated.right) marks.push('→');
  return marks.length > 0 ? ` clip ${marks.join('')}` : '';
}

// ── live view pane ──────────────────────────────────────────────────────────

function exitBadge(frame: LiveViewFrame): string {
  if (frame.exit === undefined) {
    return 'exited';
  }
  if (frame.exit.exitSignal !== null) {
    return `exited (signal ${frame.exit.exitSignal})`;
  }
  if (frame.exit.exitCode === 0) {
    return 'exited (code 0)';
  }
  return `failed (code ${String(frame.exit.exitCode ?? '?')})`;
}

function LiveView({
  frame,
  error,
  pane,
  mode,
  pan,
  focused,
}: {
  frame: LiveViewFrame | null;
  error: string | null;
  pane: { cols: number; rows: number };
  mode: LiveViewMode;
  pan: PanOffset;
  focused: boolean;
}): React.ReactNode {
  const snapshot = frame?.snapshot ?? null;
  const status = frame?.status ?? 'pending';

  let body: React.ReactNode;
  let header = '';
  if (error !== null) {
    body = <Text color="red">Live View error: {error}</Text>;
  } else if (status === 'collected') {
    body = (
      <Text color="yellow">
        Event Log collected — session no longer available.
      </Text>
    );
  } else if (snapshot === null) {
    body = <Text dimColor>Waiting for output…</Text>;
  } else {
    const view = projectLiveView({ snapshot, pane, mode, pan });
    header =
      `screen ${String(snapshot.cols)}×${String(snapshot.rows)}` +
      (snapshot.isAltScreen ? ' [alt]' : '') +
      (mode === 'overview' ? ' [overview]' : '') +
      truncationIndicator(view);
    body = (
      <Box flexDirection="column">
        {view.cells.map((row, rowIndex) => paintRow(row, rowIndex))}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      marginLeft={1}
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      width={pane.cols + 2}
    >
      <Text dimColor>
        {header.length > 0 ? header : 'live view'}
        {status === 'exited' && frame !== null
          ? `  ·  ${exitBadge(frame)}`
          : ''}
      </Text>
      {body}
    </Box>
  );
}

// ── session list pane ─────────────────────────────────────────────────────────

function statusDot(status: string): React.ReactNode {
  if (status === 'running') return <Text color="green">●</Text>;
  if (status === 'exiting' || status === 'destroying')
    return <Text color="yellow">◐</Text>;
  if (status === 'failed') return <Text color="red">○</Text>;
  return <Text dimColor>○</Text>;
}

function shortId(sessionId: string): string {
  return sessionId.length > 10 ? `…${sessionId.slice(-9)}` : sessionId;
}

function SessionList({
  sessions,
  selectedIndex,
  scope,
  focused,
  height,
}: {
  sessions: DashboardSession[];
  selectedIndex: number;
  scope: DashboardScope;
  focused: boolean;
  height: number;
}): React.ReactNode {
  // Scroll a window that keeps the selected row visible (centered when possible)
  // so navigating past the fold never hides the selection.
  const visible = Math.max(1, height - 1);
  const start =
    sessions.length <= visible
      ? 0
      : Math.min(
          Math.max(0, selectedIndex - Math.floor(visible / 2)),
          sessions.length - visible,
        );
  const windowed = sessions.slice(start, start + visible);

  return (
    <Box flexDirection="column" width={LIST_WIDTH}>
      <Text bold underline {...(focused ? { color: 'cyan' } : {})}>
        Sessions · {scope} ({sessions.length}){start > 0 ? ' ↑' : ''}
        {start + visible < sessions.length ? ' ↓' : ''}
      </Text>
      {windowed.map((session, index) => {
        const selected = start + index === selectedIndex;
        const label =
          session.name ?? session.command[0]?.split('/').pop() ?? '';
        return (
          <Text key={session.sessionId} inverse={selected} wrap="truncate">
            {selected ? '▸ ' : '  '}
            {statusDot(session.status)} {shortId(session.sessionId)} {label}
          </Text>
        );
      })}
      {sessions.length === 0 && <Text dimColor>no sessions</Text>}
    </Box>
  );
}

// ── follower wiring (one selected session at a time) ──────────────────────────

interface FollowerState {
  frame: LiveViewFrame | null;
  error: string | null;
}

function useFollower(session: DashboardSession | undefined): FollowerState {
  const [frame, setFrame] = useState<LiveViewFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionId = session?.sessionId;

  useEffect(() => {
    setFrame(null);
    setError(null);
    if (session === undefined) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    let busy = false;
    let timer: NodeJS.Timeout | undefined;
    let follower: LiveViewFollower | null = null;
    let lastStatus = '';

    // Surface a failure to the UI, but stay silent for errors caused by our own
    // teardown (a render in flight when the backend is disposed on switch/quit).
    const fail = (caught: unknown): void => {
      if (!signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };

    void (async () => {
      try {
        const backend = await createRendererBackend(
          'libghostty-vt',
          session.sessionId,
          resolveProfile('reference-dark'),
        );
        if (signal.aborted) {
          await backend.dispose();
          return;
        }
        follower = new LiveViewFollower({
          source: new EventLogTailSource(session.eventLog),
          backend,
          sessionId: session.sessionId,
          initialCols: session.initialCols,
          initialRows: session.initialRows,
        });

        timer = setInterval(() => {
          const active = follower;
          if (busy || signal.aborted || active === null) {
            return;
          }
          busy = true;
          void (async () => {
            try {
              await active.ingest();
              const changed = await active.render();
              if (
                !signal.aborted &&
                (changed || active.frame.status !== lastStatus)
              ) {
                lastStatus = active.frame.status;
                setFrame(active.frame);
              }
            } catch (caught) {
              fail(caught);
            } finally {
              busy = false;
            }
          })();
        }, FRAME_INTERVAL_MS);
      } catch (caught) {
        fail(caught);
      }
    })();

    return () => {
      controller.abort();
      if (timer !== undefined) {
        clearInterval(timer);
      }
      void follower?.dispose();
    };
  }, [sessionId]); // re-follow only when the selected Session changes

  return { frame, error };
}

// ── app ───────────────────────────────────────────────────────────────────────

function App({ options }: { options: DashboardAppOptions }): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    options.sessionId ?? null,
  );
  const [scope, setScope] = useState<DashboardScope>(options.scope);
  const [focus, setFocus] = useState<Focus>('list');
  const [mode, setMode] = useState<LiveViewMode>('one-to-one');
  const [pan, setPan] = useState<PanOffset>({ row: 0, col: 0 });
  const [error, setError] = useState<string | null>(null);

  const lastKnown = useRef<Map<string, DashboardSession>>(new Map());
  const frameRef = useRef<LiveViewFrame | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  // Refresh the Session list on an interval, pinning the selected Session
  // through its transition to Terminal (dropping it only once collected).
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    const refresh = async (): Promise<void> => {
      if (refreshing) {
        return; // a slower scan is still in flight; skip this tick
      }
      refreshing = true;
      try {
        const next = await listDashboardSessions(options.home, scope);
        if (!alive) {
          return;
        }
        for (const session of next) {
          lastKnown.current.set(session.sessionId, session);
        }
        const pinnedId = selectedIdRef.current;
        const collected = frameRef.current?.status === 'collected';
        const displayed = [...next];
        if (
          pinnedId !== null &&
          !collected &&
          !next.some((session) => session.sessionId === pinnedId)
        ) {
          const pinned = lastKnown.current.get(pinnedId);
          if (pinned !== undefined) {
            displayed.push(pinned);
          }
        }
        setSessions(displayed);
        setSelectedId((current) => {
          if (
            current !== null &&
            displayed.some((s) => s.sessionId === current)
          ) {
            return current;
          }
          // Prefix-match a requested --session id, else fall back to newest.
          const requested =
            options.sessionId !== undefined
              ? displayed.find((s) =>
                  s.sessionId.startsWith(options.sessionId ?? ''),
                )
              : undefined;
          return requested?.sessionId ?? displayed[0]?.sessionId ?? null;
        });
      } catch (caught) {
        if (alive) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), LIST_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scope, options.home, options.sessionId]);

  const selectedIndex = Math.max(
    0,
    sessions.findIndex((session) => session.sessionId === selectedId),
  );
  const selectedSession = sessions[selectedIndex];
  const { frame, error: liveError } = useFollower(selectedSession);
  frameRef.current = frame;

  const termCols = stdout.columns;
  const termRows = stdout.rows;
  const paneCols = Math.max(10, termCols - LIST_WIDTH - 5);
  const paneRows = Math.max(4, termRows - 5);

  // Clamp a candidate pan to the current screen so stored pan never drifts past
  // the edges (which would otherwise make pan keys feel dead after overshooting).
  const clampPan = (next: PanOffset): PanOffset => {
    const snapshot = frame?.snapshot;
    if (snapshot === null || snapshot === undefined) {
      return { row: 0, col: 0 };
    }
    return {
      row: Math.min(
        Math.max(0, next.row),
        Math.max(0, snapshot.rows - paneRows),
      ),
      col: Math.min(
        Math.max(0, next.col),
        Math.max(0, snapshot.cols - paneCols),
      ),
    };
  };

  const moveSelection = (delta: number): void => {
    if (sessions.length === 0) {
      return;
    }
    const nextIndex = Math.min(
      sessions.length - 1,
      Math.max(0, selectedIndex + delta),
    );
    const next = sessions[nextIndex];
    if (next !== undefined) {
      setSelectedId(next.sessionId);
      setPan({ row: 0, col: 0 });
    }
  };

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.tab) {
      setFocus((current) => (current === 'list' ? 'live' : 'list'));
      return;
    }
    if (input === 'a') {
      setScope((current) => (current === 'active' ? 'all' : 'active'));
      return;
    }
    if (input === 'z') {
      setMode((current) =>
        current === 'one-to-one' ? 'overview' : 'one-to-one',
      );
      setPan({ row: 0, col: 0 });
      return;
    }

    if (focus === 'list') {
      if (key.upArrow || input === 'k') moveSelection(-1);
      if (key.downArrow || input === 'j') moveSelection(1);
      return;
    }

    // focus === 'live': pan the clipped screen (no-op in overview).
    if (key.upArrow || input === 'k')
      setPan((p) => clampPan({ row: p.row - PAN_STEP, col: p.col }));
    if (key.downArrow || input === 'j')
      setPan((p) => clampPan({ row: p.row + PAN_STEP, col: p.col }));
    if (key.leftArrow || input === 'h')
      setPan((p) => clampPan({ row: p.row, col: p.col - PAN_STEP }));
    if (key.rightArrow || input === 'l')
      setPan((p) => clampPan({ row: p.row, col: p.col + PAN_STEP }));
  });

  return (
    <Box flexDirection="column" width={termCols}>
      <Box>
        {/* Bold cyan, no background: a filled `backgroundColor="blue"` bar
            renders light-on-light (washed out) under dark themes that remap
            ANSI blue to a light shade (e.g. Catppuccin's #89b4fa). A bold
            foreground accent stays readable on any terminal/theme. */}
        <Text color="cyan" bold>
          {'agent-tty dashboard'}
        </Text>
        <Text dimColor>
          {'  read-only · '}
          {selectedSession
            ? `${shortId(selectedSession.sessionId)} ${selectedSession.status}`
            : 'no session selected'}
        </Text>
      </Box>

      <Box>
        <SessionList
          sessions={sessions}
          selectedIndex={selectedIndex}
          scope={scope}
          focused={focus === 'list'}
          height={paneRows}
        />
        <LiveView
          frame={frame}
          error={liveError}
          pane={{ cols: paneCols, rows: paneRows }}
          mode={mode}
          pan={pan}
          focused={focus === 'live'}
        />
      </Box>

      <Box>
        <Text dimColor>
          {`focus:${focus} · Tab switch · `}
          {focus === 'list' ? '↑/↓ j/k select' : '↑/↓ h/j/k/l pan'}
          {' · a scope · z overview · q quit'}
          {error !== null ? ` · ERR: ${error}` : ''}
        </Text>
      </Box>
    </Box>
  );
}

export async function runDashboardApp(
  options: DashboardAppOptions,
): Promise<void> {
  const instance = render(<App options={options} />);
  await instance.waitUntilExit();
}
