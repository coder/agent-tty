import { access } from 'node:fs/promises';

import type { CommandContext } from '../context.js';
import type {
  RecordDiffResult,
  RecordDiffSide,
} from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import { CliError } from '../errors.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { RecordDiffResultSchema } from '../../protocol/messages.js';
import {
  canonicalVisibleLines,
  computeScreenHash,
} from '../../renderer/canonicalScreen.js';
import { withOfflineReplayRenderer } from '../../replay/offlineReplay.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
} from '../../storage/sessionPaths.js';
import { diffLines } from '../../util/lineDiff.js';
import { invariant } from '../../util/assert.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionIdA: string;
  sessionIdB: string;
  atSeqA: number | undefined;
  atSeqB: number | undefined;
}

interface ReplayedScreen {
  readonly side: RecordDiffSide;
  readonly visibleLines: readonly string[];
}

function assertValidAtSeq(value: number | undefined, flag: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: `${flag} must be a non-negative integer.`,
      details: { [flag]: value },
    });
  }
}

async function resolveSessionDirectory(
  home: string,
  sessionId: string,
): Promise<string> {
  let sessionDirectory: string;
  try {
    sessionDirectory = sessionDir(home, sessionId);
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_SESSION_ID, {
      message: `Session ID "${sessionId}" is invalid.`,
      details: { sessionId },
      cause: error,
    });
  }

  const manifestFile = manifestPath(sessionDirectory);
  const manifest = await readManifestIfExists(manifestFile);
  if (manifest === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${sessionId}" was not found.`,
      details: { sessionId, manifestPath: manifestFile },
    });
  }

  return sessionDirectory;
}

async function assertEventLogExists(
  sessionDirectory: string,
  sessionId: string,
): Promise<void> {
  const eventsFile = eventLogPath(sessionDirectory);
  try {
    await access(eventsFile);
  } catch (error) {
    throw makeCliError(ERROR_CODES.REPLAY_ERROR, {
      message: `Session "${sessionId}" has no event log; the canonical log was deleted or never written.`,
      details: { sessionId, eventLogPath: eventsFile },
      cause: error,
    });
  }
}

async function replayScreen(
  context: CommandContext,
  sessionId: string,
  targetSeq: number | undefined,
): Promise<ReplayedScreen> {
  const sessionDirectory = await resolveSessionDirectory(
    context.home,
    sessionId,
  );

  try {
    return await withOfflineReplayRenderer(
      {
        sessionDir: sessionDirectory,
        rendererName: context.rendererDefault,
        ...(targetSeq === undefined ? {} : { targetSeq }),
      },
      async ({ backend, replayInput }) => {
        if (replayInput.targetSeq < 0) {
          // The session has not emitted any events yet, so its screen is the
          // valid initial blank grid. Backends reject snapshot() before the
          // first replayed event, so synthesize the blank screen directly.
          // capturedAtSeq -1 mirrors targetSeq: no event was replayed.
          //
          // The host creates events.jsonl at startup, so an empty replay is
          // only authoritative when the (zero-length) log file exists; a
          // missing file means the canonical log was deleted or never
          // written and must not be reported as a blank screen.
          await assertEventLogExists(sessionDirectory, sessionId);
          const blankLines = Array.from(
            { length: replayInput.initialRows },
            () => '',
          );
          return {
            side: {
              sessionId,
              capturedAtSeq: -1,
              cols: replayInput.initialCols,
              rows: replayInput.initialRows,
              screenHash: computeScreenHash({
                visibleLines: blankLines.map((text) => ({ text })),
              }),
            },
            visibleLines: blankLines,
          };
        }

        const snapshot = await backend.snapshot({ includeScrollback: false });
        return {
          side: {
            sessionId,
            capturedAtSeq: snapshot.capturedAtSeq,
            cols: snapshot.cols,
            rows: snapshot.rows,
            screenHash: computeScreenHash(snapshot),
          },
          visibleLines: canonicalVisibleLines(snapshot),
        };
      },
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw makeCliError(ERROR_CODES.REPLAY_ERROR, {
      message: `Failed to replay session "${sessionId}" for record diff.`,
      details: {
        sessionId,
        ...(targetSeq === undefined ? {} : { targetSeq }),
      },
      cause: error,
    });
  }
}

function buildResultLines(result: RecordDiffResult): string[] {
  const header = [
    `--- ${result.a.sessionId} @seq ${String(result.a.capturedAtSeq)} (${result.a.screenHash.slice(0, 12)})`,
    `+++ ${result.b.sessionId} @seq ${String(result.b.capturedAtSeq)} (${result.b.screenHash.slice(0, 12)})`,
  ];

  if (result.identical) {
    return [...header, 'Screens are identical.'];
  }

  const markers: Record<'equal' | 'delete' | 'add', string> = {
    equal: ' ',
    delete: '-',
    add: '+',
  };
  return [
    ...header,
    ...result.diff.map((entry) => `${markers[entry.op]}${entry.text}`),
  ];
}

export async function runRecordDiffCommand(
  options: CommandOptions,
): Promise<void> {
  assertValidAtSeq(options.atSeqA, 'at-seq-a');
  assertValidAtSeq(options.atSeqB, 'at-seq-b');

  const a = await replayScreen(
    options.context,
    options.sessionIdA,
    options.atSeqA,
  );
  // When both selectors are identical, reuse the first replay instead of
  // re-reading the event log: a running session may append output between the
  // two reads, which would make `record diff <id> <id>` spuriously
  // non-identical.
  const sameSelector =
    options.sessionIdA === options.sessionIdB &&
    options.atSeqA === options.atSeqB;
  const b = sameSelector
    ? a
    : await replayScreen(options.context, options.sessionIdB, options.atSeqB);

  const identical = a.side.screenHash === b.side.screenHash;
  const diff = identical ? [] : diffLines(a.visibleLines, b.visibleLines);
  if (identical) {
    invariant(
      a.visibleLines.join('\n') === b.visibleLines.join('\n'),
      'equal screen hashes must imply equal canonical visible text',
    );
  }

  const rawResult = { identical, a: a.side, b: b.side, diff };
  const parsedResult = RecordDiffResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.INTERNAL_ERROR, {
      message: 'Generated record diff result did not match the schema.',
      details: { issues: parsedResult.error.issues },
      cause: parsedResult.error,
    });
  }

  emitSuccess({
    command: 'record diff',
    json: options.json,
    result: parsedResult.data,
    lines: buildResultLines(parsedResult.data),
  });
}
