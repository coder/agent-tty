import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { buildReplayInput } from '../host/replay.js';
import type { EventRecord, SessionRecord } from '../protocol/schemas.js';
import { resolveProfile } from '../renderer/profiles.js';
import {
  GhosttyWebBackend,
  type AcceleratedTimingOptions,
  type VideoRecordingOptions,
} from '../renderer/ghosttyWeb/backend.js';

export interface WebmExportOptions {
  sessionId: string;
  sessionDir: string;
  manifest: SessionRecord;
  events: EventRecord[];
  outputPath: string;
  targetSeq?: number;
  profileName?: string;
}

export interface WebmExportResult {
  capturedAtSeq: number;
  durationMs: number;
  outputEventCount: number;
  resizeEventCount: number;
  cols: number;
  rows: number;
  profileName: string;
  timingMode: 'accelerated';
}

function parseTimestamp(timestamp: string, label: string): number {
  const parsedTimestamp = Date.parse(timestamp);
  assert(
    Number.isFinite(parsedTimestamp),
    `${label} must be a valid ISO timestamp`,
  );
  return parsedTimestamp;
}

export async function generateWebmExport(
  options: WebmExportOptions,
): Promise<WebmExportResult> {
  assert(options.sessionId.length > 0, 'sessionId is required');
  assert(isAbsolute(options.sessionDir), 'sessionDir must be absolute');
  assert(options.outputPath.length > 0, 'outputPath is required');
  assert(isAbsolute(options.outputPath), 'outputPath must be absolute');
  assert(options.events.length > 0, 'events must not be empty');

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
  assert(cols > 0, 'initial cols must be positive');
  assert(rows > 0, 'initial rows must be positive');

  const viewportWidth = Math.max(
    640,
    Math.ceil(cols * profile.fontSize * 0.65) + 32,
  );
  const viewportHeight = Math.max(
    480,
    Math.ceil(rows * profile.fontSize * 1.5) + 32,
  );
  const videoTmpDir = await mkdtemp(join(tmpdir(), 'agent-terminal-webm-'));
  const videoOptions: VideoRecordingOptions = {
    outputDir: videoTmpDir,
    size: {
      width: viewportWidth,
      height: viewportHeight,
    },
  };
  const timingOptions: AcceleratedTimingOptions = {};
  const backend = new GhosttyWebBackend(
    options.sessionId,
    profile,
    videoOptions,
  );

  try {
    await backend.boot();

    const replayState = await backend.replayWithTiming(
      replayInput,
      timingOptions,
    );
    await backend.finalizeVideo(options.outputPath);

    const exportedEvents = replayInput.events.filter(
      (event) => event.seq <= replayInput.targetSeq,
    );
    const firstEvent = exportedEvents[0];
    const lastEvent = exportedEvents.at(-1);
    assert(firstEvent !== undefined, 'expected at least one exported event');
    assert(lastEvent !== undefined, 'expected at least one exported event');

    const firstTimestamp = parseTimestamp(
      firstEvent.ts,
      'first exported event timestamp',
    );
    const lastTimestamp = parseTimestamp(
      lastEvent.ts,
      'last exported event timestamp',
    );
    assert(
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
      timingMode: 'accelerated',
    };
  } finally {
    await backend.dispose();
    await rm(videoTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
