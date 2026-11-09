import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { buildReplayInput } from '../host/replay.js';
import {
  ReplayTimingModeSchema,
  type EventRecord,
  type ReplayTimingMode,
  type SessionRecord,
} from '../protocol/schemas.js';
import type {
  RecordedGlyphFields,
  ReplayProgress,
  ReplayTimingOptions,
  VideoCapableRendererBackend,
  VideoRecordingOptions,
} from '../renderer/backend.js';
import { GhosttyWebBackend } from '../renderer/ghosttyWeb/backend.js';
import {
  DEFAULT_RENDERER_NAME,
  resolveRendererName,
  type RendererName,
} from '../renderer/names.js';
import { resolveProfile } from '../renderer/profiles.js';
import type { RenderProfileConfig, ReplayState } from '../renderer/types.js';
import { invariant, unreachable } from '../util/assert.js';

// The replay fails when the renderer makes no progress for this long. A healthy
// replay is silent for a few seconds at most, in three places: from the start
// to the first report (it sizes the terminal and holds one frame), inside one
// page call (the call that ends a flush writes the chunks of the whole flush,
// which the event log limit of 50 MiB bounds), and from the last report to the
// end (the final frame hold, which also covers the glyph probes, and then a
// read of the screen). On a loaded host at 600x150 the start took 1.5 s at most
// and the end 2.3 s, and a flush of 52 MB took 2.8 s. The window is the old
// fixed limit on the whole replay, so an export that fit before still fits.
// Boot and finalize run outside the watchdog.
const REPLAY_STALL_WINDOW_MS = 5 * 60 * 1000;
// Node runs a timer with a longer delay after 1 ms.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
// maxGapMs/minFrameHoldMs are tuned for watchability: shorter clamps make the
// video flicker because every idle gap collapses to a near-instant cut.
const ACCELERATED_TIMING: ReplayTimingOptions = Object.freeze({
  mode: 'accelerated' as const,
  maxGapMs: 400,
  minFrameHoldMs: 100,
  finalFrameHoldMs: 1_000,
});

function buildReplayTimingOptions(mode: ReplayTimingMode): ReplayTimingOptions {
  const validatedMode = ReplayTimingModeSchema.parse(mode);

  switch (validatedMode) {
    case 'accelerated':
      return ACCELERATED_TIMING;
    case 'recorded':
      return { mode: 'recorded', finalFrameHoldMs: 1_000 };
    case 'max-speed':
      return { mode: 'max-speed', minFrameHoldMs: 16, finalFrameHoldMs: 500 };
    default:
      unreachable(validatedMode, 'unsupported replay timing mode');
  }
}

export class WebmReplayStallError extends Error {
  public readonly stallWindowMs: number;
  // Seq of the last event that the replay reached, or -1 when it had reached
  // none before it stalled.
  public readonly lastSeq: number;
  public readonly timingMode: ReplayTimingMode;

  public constructor(
    stallWindowMs: number,
    lastSeq: number,
    timingMode: ReplayTimingMode,
  ) {
    super(
      `WebM replay stalled: the renderer made no progress for ${String(stallWindowMs)} ms (last event seq ${String(lastSeq)}, ${timingMode} timing)`,
    );
    this.name = 'WebmReplayStallError';
    this.stallWindowMs = stallWindowMs;
    this.lastSeq = lastSeq;
    this.timingMode = timingMode;
  }
}

export interface WebmExportOptions {
  sessionId: string;
  sessionDir: string;
  manifest: SessionRecord;
  events: EventRecord[];
  outputPath: string;
  targetSeq?: number;
  profileName?: string;
  timingMode?: ReplayTimingMode;
  rendererName?: RendererName;
}

export interface WebmExportDeps {
  backendFactory?: (
    rendererName: RendererName,
    sessionId: string,
    profile: RenderProfileConfig,
    videoOptions: VideoRecordingOptions,
  ) => VideoCapableRendererBackend;
  stallWindowMs?: number;
}

export interface WebmExportResult extends RecordedGlyphFields {
  capturedAtSeq: number;
  durationMs: number;
  outputEventCount: number;
  resizeEventCount: number;
  cols: number;
  rows: number;
  profileName: string;
  timingMode: ReplayTimingMode;
  rendererBackend: RendererName;
}

function createDefaultBackend(
  rendererName: RendererName,
  sessionId: string,
  profile: RenderProfileConfig,
  videoOptions: VideoRecordingOptions,
): VideoCapableRendererBackend {
  invariant(
    rendererName === 'ghostty-web',
    'WebM export currently requires the ghostty-web renderer backend',
  );
  return new GhosttyWebBackend(sessionId, profile, videoOptions);
}

function parseTimestamp(timestamp: string, label: string): number {
  const parsedTimestamp = Date.parse(timestamp);
  invariant(
    Number.isFinite(parsedTimestamp),
    `${label} must be a valid ISO timestamp`,
  );
  return parsedTimestamp;
}

// Fails the replay when the renderer makes no progress for `stallWindowMs`.
// The replay reports progress (see ReplayProgress) and each report restarts the
// window. A wait on the timing schedule is not a stall, so the window starts
// after that wait. A timer runs at most MAX_TIMER_DELAY_MS, so a longer span
// is a chain of timers.
async function replayWithStallWatchdog(
  backend: VideoCapableRendererBackend,
  replayInput: ReturnType<typeof buildReplayInput>,
  timingOptions: ReplayTimingOptions,
  stallWindowMs: number,
): Promise<ReplayState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSeq = -1;
  let done = false;
  let rejectStall: (error: WebmReplayStallError) => void = () => undefined;
  const stalled = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });

  const arm = (remainingMs: number): void => {
    const delayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (remainingMs > delayMs) {
        arm(remainingMs - delayMs);
        return;
      }
      done = true;
      rejectStall(
        new WebmReplayStallError(stallWindowMs, lastSeq, timingOptions.mode),
      );
    }, delayMs);
  };
  const onProgress = (progress: ReplayProgress): void => {
    // A replay that outlives its failure must not start a timer again.
    if (done) {
      return;
    }
    invariant(
      Number.isInteger(progress.seq) && progress.seq >= -1,
      'replay progress seq must be an integer of at least -1',
    );
    invariant(
      Number.isFinite(progress.scheduledWaitMs) &&
        progress.scheduledWaitMs >= 0,
      'replay progress scheduledWaitMs must be a non-negative number',
    );
    clearTimeout(timer);
    lastSeq = progress.seq;
    arm(progress.scheduledWaitMs + stallWindowMs);
  };

  arm(stallWindowMs);
  try {
    return await Promise.race([
      backend.replayWithTiming(replayInput, timingOptions, onProgress),
      stalled,
    ]);
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

export async function generateWebmExport(
  options: WebmExportOptions,
  deps?: WebmExportDeps,
): Promise<WebmExportResult> {
  invariant(options.sessionId.length > 0, 'sessionId is required');
  invariant(isAbsolute(options.sessionDir), 'sessionDir must be absolute');
  invariant(options.outputPath.length > 0, 'outputPath is required');
  invariant(isAbsolute(options.outputPath), 'outputPath must be absolute');

  const replayInput = buildReplayInput(
    options.sessionId,
    options.manifest,
    options.events,
    options.targetSeq,
  );

  const profileName = options.profileName ?? 'reference-dark';
  const profile = resolveProfile(profileName);
  const cols = replayInput.initialCols;
  const rows = replayInput.initialRows;
  invariant(cols > 0, 'initial cols must be positive');
  invariant(rows > 0, 'initial rows must be positive');

  const viewportWidth = Math.max(
    640,
    Math.ceil(cols * profile.fontSize * 0.65) + 32,
  );
  const viewportHeight = Math.max(
    480,
    Math.ceil(rows * profile.fontSize * 1.5) + 32,
  );
  const videoTmpDir = await mkdtemp(join(tmpdir(), 'agent-tty-webm-'));
  let backend: VideoCapableRendererBackend | null = null;

  try {
    await chmod(videoTmpDir, 0o700);

    const videoOptions: VideoRecordingOptions = {
      outputDir: videoTmpDir,
      size: {
        width: viewportWidth,
        height: viewportHeight,
      },
    };
    // Default to wall-clock timing so exported videos match the recorded pace.
    const resolvedTimingMode: ReplayTimingMode =
      options.timingMode ?? 'recorded';
    const timingOptions = buildReplayTimingOptions(resolvedTimingMode);
    const backendFactory = deps?.backendFactory ?? createDefaultBackend;
    const requestedRendererName = resolveRendererName(
      options.rendererName ?? DEFAULT_RENDERER_NAME,
    );
    // libghostty-vt is semantic-only; WebM output must be produced by ghostty-web.
    const videoRendererName: RendererName =
      requestedRendererName === 'libghostty-vt'
        ? 'ghostty-web'
        : requestedRendererName;
    const stallWindowMs = deps?.stallWindowMs ?? REPLAY_STALL_WINDOW_MS;

    invariant(
      Number.isFinite(stallWindowMs) && stallWindowMs > 0,
      'stallWindowMs must be a positive number when provided',
    );
    backend = backendFactory(
      videoRendererName,
      options.sessionId,
      profile,
      videoOptions,
    );

    await backend.boot();

    const replayState = await replayWithStallWatchdog(
      backend,
      replayInput,
      timingOptions,
      stallWindowMs,
    );
    const missingGlyphs = await backend.recordedMissingGlyphs();
    await backend.finalizeVideo(options.outputPath);

    const exportedEvents = replayInput.events.filter(
      (event) => event.seq <= replayInput.targetSeq,
    );
    const firstEvent = exportedEvents[0];
    const lastEvent = exportedEvents.at(-1);
    const firstTimestamp =
      firstEvent === undefined
        ? 0
        : parseTimestamp(firstEvent.ts, 'first exported event timestamp');
    const lastTimestamp =
      lastEvent === undefined
        ? 0
        : parseTimestamp(lastEvent.ts, 'last exported event timestamp');
    invariant(
      lastTimestamp >= firstTimestamp,
      'last exported event timestamp must not precede the first exported event timestamp',
    );

    let outputEventCount = 0;
    let resizeEventCount = 0;
    for (const event of exportedEvents) {
      if (event.type === 'output') {
        outputEventCount += 1;
      }

      if (event.type === 'resize') {
        resizeEventCount += 1;
      }
    }

    return {
      capturedAtSeq: replayInput.targetSeq,
      durationMs: Math.max(0, lastTimestamp - firstTimestamp),
      outputEventCount,
      resizeEventCount,
      cols: replayState.cols,
      rows: replayState.rows,
      profileName,
      timingMode: resolvedTimingMode,
      rendererBackend: videoRendererName,
      ...missingGlyphs,
    };
  } finally {
    if (backend !== null) {
      await backend.dispose();
    }
    await rm(videoTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
