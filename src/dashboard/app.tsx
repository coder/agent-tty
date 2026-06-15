import { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout, type Key } from 'ink';

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
  listRegisteredHomes,
  type RegisteredHome,
} from '../storage/homeScope.js';
import {
  listDashboardSessions,
  type DashboardScope,
  type DashboardSession,
} from './sessionScope.js';
import {
  PANE_BORDER,
  PANE_LIST_GAP,
  formatSessionId,
  paneLayout,
  shortId,
} from './sessionListLayout.js';

// reference-dark profile defaults; cells matching these are left unstyled so the
// terminal's own theme shows through instead of repainting every cell.
const PROFILE_BG = '#1e1e2e';
const PROFILE_FG = '#cdd6f4';
const FRAME_INTERVAL_MS = 33;
const LIST_REFRESH_MS = 1500;
const PAN_STEP = 1;

type Focus = 'list' | 'live' | 'home';

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
  maximized = false,
}: {
  frame: LiveViewFrame | null;
  error: string | null;
  pane: { cols: number; rows: number };
  mode: LiveViewMode;
  pan: PanOffset;
  focused: boolean;
  // When maximized the bordered pane sits flush to the left edge and spans the
  // full width (the list is gone); otherwise it has a 1-col gap beside the list.
  maximized?: boolean;
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
      marginLeft={maximized ? 0 : PANE_LIST_GAP}
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      width={pane.cols + PANE_BORDER}
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

function SessionList({
  sessions,
  selectedIndex,
  scope,
  focused,
  height,
  width,
}: {
  sessions: DashboardSession[];
  selectedIndex: number;
  scope: DashboardScope;
  focused: boolean;
  height: number;
  width: number;
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
    <Box flexDirection="column" width={width}>
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
            {statusDot(session.status)}{' '}
            {formatSessionId(session.sessionId, width)} {label}
          </Text>
        );
      })}
      {sessions.length === 0 && <Text dimColor>no sessions</Text>}
    </Box>
  );
}

// ── home picker (full-screen) ─────────────────────────────────────────────────

function shortHomePath(home: string): string {
  // Show the trailing two path segments so throwaway temp Homes and
  // ~/.agent-tty stay distinguishable without overflowing the header.
  const segments = home.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 2) {
    return home;
  }
  return `…/${segments.slice(-2).join('/')}`;
}

function homeName(home: string): string {
  const segments = home.split('/').filter((segment) => segment.length > 0);
  return segments.at(-1) ?? home;
}

/** Compact "time since" for the picker's last-seen column (s/m/h/d). */
function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return '?';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h`;
  }
  return `${String(Math.floor(hours / 24))}d`;
}

const HOME_NAME_WIDTH = 22;
const HOME_COUNT_WIDTH = 18;

/**
 * The full-screen Home picker: a deliberate mode switch that takes over the
 * body (both the Session list and the Live View) while choosing a Home, so it
 * reads as "switch Home" rather than an in-place content swap. Selecting a Home
 * returns to the normal two-pane view on that Home.
 */
function HomePicker({
  homes,
  selectedIndex,
  scope,
  currentHome,
  height,
  width,
}: {
  homes: RegisteredHome[];
  selectedIndex: number;
  scope: DashboardScope;
  currentHome: string;
  height: number;
  width: number;
}): React.ReactNode {
  // Box border (2) + header (1) + current-Home footer (1) frame the rows.
  const visible = Math.max(1, height - 4);
  const start =
    homes.length <= visible
      ? 0
      : Math.min(
          Math.max(0, selectedIndex - Math.floor(visible / 2)),
          homes.length - visible,
        );
  const windowed = homes.slice(start, start + visible);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      width={width}
    >
      <Text bold>
        Switch Home · {scope} ({homes.length}){start > 0 ? ' ↑' : ''}
        {start + visible < homes.length ? ' ↓' : ''}
      </Text>
      {homes.length === 0 ? (
        <Text dimColor>
          No registered Homes — create a session in one to register it.
        </Text>
      ) : (
        windowed.map((home, index) => {
          const selected = start + index === selectedIndex;
          const isCurrent = home.path === currentHome;
          const counts = `${String(home.activeSessions)} active / ${String(home.totalSessions)}`;
          return (
            <Text key={home.path} inverse={selected} wrap="truncate">
              {selected ? '▸ ' : '  '}
              {isCurrent ? (
                <Text color="green">◉</Text>
              ) : (
                <Text dimColor>○</Text>
              )}
              {'  '}
              {homeName(home.path).padEnd(HOME_NAME_WIDTH)}
              {counts.padEnd(HOME_COUNT_WIDTH)}
              {'last seen '}
              {relativeAge(home.lastSeenAt)}
            </Text>
          );
        })
      )}
      <Text dimColor>{`current: ${shortHomePath(currentHome)}`}</Text>
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
  // When true the Live View is "maximized": it takes over the whole dashboard
  // body (the Session list is dropped) and spans the full terminal width while
  // staying framed by its border, so the viewport is large enough that panning
  // is rarely needed. It is a modal layer orthogonal to `focus` — it never
  // mutates `focus`, so Esc restores whatever was focused underneath.
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The Home the dashboard currently observes. Initialized to the launched/
  // resolved Home (additive picker); selecting another Home in the picker only
  // changes what is observed, never restricting navigation.
  const [home, setHome] = useState<string>(options.home);
  const [homes, setHomes] = useState<RegisteredHome[]>([]);
  const [homeIndex, setHomeIndex] = useState(0);

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
        const next = await listDashboardSessions(home, scope);
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
  }, [scope, home, options.sessionId]);

  // Load registered Homes whenever the picker opens or the scope changes while
  // it is open. This is a read-only scan (no reconciliation) shared with
  // `home list`, so browsing Homes never mutates any Session.
  useEffect(() => {
    if (focus !== 'home') {
      return;
    }
    // Object flag (not a bare boolean) so a stale async resolution after the
    // picker closes or the scope changes can't clobber fresh state.
    const load = { cancelled: false };
    void (async () => {
      try {
        const registered = await listRegisteredHomes(scope);
        if (load.cancelled) {
          return;
        }
        setHomes(registered);
        setHomeIndex(0);
      } catch (caught) {
        if (!load.cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
    return () => {
      load.cancelled = true;
    };
  }, [focus, scope]);

  const selectedIndex = Math.max(
    0,
    sessions.findIndex((session) => session.sessionId === selectedId),
  );
  const selectedSession = sessions[selectedIndex];
  const { frame, error: liveError } = useFollower(selectedSession);
  frameRef.current = frame;

  const termCols = stdout.columns;
  const termRows = stdout.rows;
  // Pane geometry (see `paneLayout`): split shares the width with the Session
  // list; maximized drops the list to span the full width while keeping the same
  // right edge. `paneCols` is the *effective* content width for the current
  // mode, so clampPan, the projection, and the rendered pane all agree.
  const { listWidth, paneCols, paneRows } = paneLayout(
    termCols,
    termRows,
    maximized,
  );

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

  // Toggle the lossy Overview projection. Pan is meaningless in Overview, so
  // reset it (matching every other view transition).
  const toggleOverview = (): void => {
    setMode((current) =>
      current === 'one-to-one' ? 'overview' : 'one-to-one',
    );
    setPan({ row: 0, col: 0 });
  };

  // Arrow / hjkl panning of the clipped one-to-one screen, clamped to the
  // current pane. Shared by the focused split pane and the maximized layer.
  const handlePanKeys = (input: string, key: Key): void => {
    if (key.upArrow || input === 'k')
      setPan((p) => clampPan({ row: p.row - PAN_STEP, col: p.col }));
    if (key.downArrow || input === 'j')
      setPan((p) => clampPan({ row: p.row + PAN_STEP, col: p.col }));
    if (key.leftArrow || input === 'h')
      setPan((p) => clampPan({ row: p.row, col: p.col - PAN_STEP }));
    if (key.rightArrow || input === 'l')
      setPan((p) => clampPan({ row: p.row, col: p.col + PAN_STEP }));
  };

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    // While maximized this layer owns input: only pan / overview / restore
    // respond. Tab, H and 'a' are swallowed so it reads as a distinct mode.
    // `focus` is left untouched, so Esc/Enter (restore) returns to whatever was
    // focused underneath. Enter both maximizes and restores, so it toggles.
    if (maximized) {
      if (key.escape || key.return) {
        setMaximized(false);
        setPan({ row: 0, col: 0 });
        return;
      }
      if (input === 'z') {
        toggleOverview();
        return;
      }
      handlePanKeys(input, key);
      return;
    }
    // 'H' toggles the Home picker from anywhere; it is additive — closing it
    // leaves the current Home and Session selection untouched.
    if (input === 'H') {
      setFocus((current) => (current === 'home' ? 'list' : 'home'));
      return;
    }
    // 'a' toggles active/all scope for both the Session list and the Home
    // picker (they share one scope), mirroring `list`/`home list`.
    if (input === 'a') {
      setScope((current) => (current === 'active' ? 'all' : 'active'));
      return;
    }

    if (focus === 'home') {
      if (key.escape) {
        setFocus('list');
        return;
      }
      if (key.upArrow || input === 'k') {
        setHomeIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setHomeIndex((index) =>
          Math.min(Math.max(0, homes.length - 1), index + 1),
        );
        return;
      }
      if (key.return) {
        const picked = homes[homeIndex];
        if (picked !== undefined && picked.path !== home) {
          // Switching Home re-seeds the Session list (which reconciles on
          // entry); clear pinned state carried over from the previous Home.
          setHome(picked.path);
          setSelectedId(null);
          lastKnown.current = new Map();
          setPan({ row: 0, col: 0 });
        }
        setFocus('list');
        return;
      }
      return; // swallow other keys while the picker is open
    }

    if (key.tab) {
      setFocus((current) => (current === 'list' ? 'live' : 'list'));
      return;
    }
    if (input === 'z') {
      toggleOverview();
      return;
    }

    // Enter maximizes the Live View — from the list (jump straight from
    // browsing to a full-bleed view of the selected session) or from the pane.
    // It is a modal layer: `focus` is left as-is, so Esc restores it. Reset pan
    // like every other geometry change, and no-op when nothing is selected.
    if (key.return) {
      if (selectedSession !== undefined) {
        setMaximized(true);
        setPan({ row: 0, col: 0 });
      }
      return;
    }

    if (focus === 'list') {
      if (key.upArrow || input === 'k') moveSelection(-1);
      if (key.downArrow || input === 'j') moveSelection(1);
      return;
    }

    // focus === 'live': pan the clipped screen (no-op in overview).
    handlePanKeys(input, key);
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
          {focus === 'home'
            ? '  read-only · choosing Home…'
            : `  read-only · ${shortHomePath(home)} · ${
                selectedSession
                  ? `${shortId(selectedSession.sessionId)} ${selectedSession.status}`
                  : 'no session selected'
              }`}
        </Text>
      </Box>

      <Box>
        {focus === 'home' ? (
          // Full-screen takeover: the picker replaces both panes so switching a
          // Home reads as a deliberate mode, not an in-place content swap.
          <HomePicker
            homes={homes}
            selectedIndex={homeIndex}
            scope={scope}
            currentHome={home}
            height={paneRows}
            width={termCols}
          />
        ) : maximized ? (
          // Maximized: the Live View takes the whole body (no list), full width
          // but still bordered. The header and footer bars stay. It is the sole
          // active view, so it always renders focused.
          <LiveView
            frame={frame}
            error={liveError}
            pane={{ cols: paneCols, rows: paneRows }}
            mode={mode}
            pan={pan}
            focused
            maximized
          />
        ) : (
          <>
            <SessionList
              sessions={sessions}
              selectedIndex={selectedIndex}
              scope={scope}
              focused={focus === 'list'}
              height={paneRows}
              width={listWidth}
            />
            <LiveView
              frame={frame}
              error={liveError}
              pane={{ cols: paneCols, rows: paneRows }}
              mode={mode}
              pan={pan}
              focused={focus === 'live'}
            />
          </>
        )}
      </Box>

      <Box>
        <Text dimColor>
          {maximized
            ? 'maximized · ↑/↓ h/j/k/l pan · z overview · esc/⏎ restore · q quit'
            : focus === 'home'
              ? '↑/↓ j/k select Home · ⏎ open · a scope · esc cancel · q quit'
              : focus === 'list'
                ? 'focus:list · Tab switch · ↑/↓ j/k select · ⏎ maximize · a scope · H homes · z overview · q quit'
                : 'focus:live · Tab switch · ↑/↓ h/j/k/l pan · ⏎ maximize · a scope · H homes · z overview · q quit'}
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
