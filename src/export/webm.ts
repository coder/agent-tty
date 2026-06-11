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

const REPLAY_TIMEOUT_MS = 5 * 60 * 1000;
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
  replayTimeoutMs?: number;
}

export interface WebmExportResult {
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

async function replayWithTimeout(
  backend: VideoCapableRendererBackend,
  replayInput: ReturnType<typeof buildReplayInput>,
  timingOptions: ReplayTimingOptions,
  timeoutMs: number,
): Promise<ReplayState> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      backend.replayWithTiming(replayInput, timingOptions),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('WebM replay timed out after 5 minutes'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
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
  invariant(options.events.length > 0, 'events must not be empty');

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
    const replayTimeoutMs = deps?.replayTimeoutMs ?? REPLAY_TIMEOUT_MS;

    invariant(
      replayTimeoutMs > 0,
      'replayTimeoutMs must be a positive number when provided',
    );
    backend = backendFactory(
      videoRendererName,
      options.sessionId,
      profile,
      videoOptions,
    );

    await backend.boot();

    const replayState = await replayWithTimeout(
      backend,
      replayInput,
      timingOptions,
      replayTimeoutMs,
    );
    await backend.finalizeVideo(options.outputPath);

    const exportedEvents = replayInput.events.filter(
      (event) => event.seq <= replayInput.targetSeq,
    );
    const firstEvent = exportedEvents[0];
    const lastEvent = exportedEvents.at(-1);
    invariant(firstEvent !== undefined, 'expected at least one exported event');
    invariant(lastEvent !== undefined, 'expected at least one exported event');

    const firstTimestamp = parseTimestamp(
      firstEvent.ts,
      'first exported event timestamp',
    );
    const lastTimestamp = parseTimestamp(
      lastEvent.ts,
      'last exported event timestamp',
    );
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
    };
  } finally {
    if (backend !== null) {
      await backend.dispose();
    }
    await rm(videoTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
