import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendRpc } from '../../src/host/rpcClient.js';
import type {
  ScreenshotResult,
  SnapshotResult,
  WaitResult,
} from '../../src/protocol/messages.js';
import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import {
  artifactPath,
  screenshotFilename,
  snapshotFilename,
} from '../../src/storage/artifactPaths.js';
import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

const SNAPSHOT_TIMEOUT_MS = 60_000;
const OUTPUT_MARKER = 'hello-structured';

const SCROLLBACK_OUTPUT_MARKER = 'line-50';

async function waitForOutputMarker(
  testHome: string,
  sessionId: string,
  marker: string,
): Promise<void> {
  const waitResult = runCli(
    ['wait', sessionId, '--idle-ms', '2000', '--timeout', '10000', '--json'],
    { AGENT_TTY_HOME: testHome },
    15_000,
  );

  expect(waitResult.status).toBe(0);
  expect(waitResult.stderr).toBe('');
  const waitEnvelope = JSON.parse(
    waitResult.stdout,
  ) as SuccessEnvelope<WaitResult>;
  expect(waitEnvelope.ok).toBe(true);
  expect(waitEnvelope.result.timedOut).toBe(false);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await readEvents(testHome, sessionId).catch(() => []);
    const output = events
      .filter((event) => event.type === 'output')
      .map((event) => {
        const data = event.payload.data;
        return typeof data === 'string' ? data : '';
      })
      .join('');

    if (output.includes(marker)) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`timed out waiting for output marker ${marker}`);
}

describe(
  'host renderer snapshot/screenshot RPC integration',
  { timeout: 120_000 },
  () => {
    let testHome = '';
    let sessionId = '';
    let rpcSocketPath = '';
    let sessDir = '';

    beforeEach(async () => {
      // prettier-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-host-renderer-')));
      sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        `echo ${OUTPUT_MARKER}; exec cat`,
      ]);

      await waitForOutputMarker(testHome, sessionId, OUTPUT_MARKER);

      sessDir = sessionDir(testHome, sessionId);
      rpcSocketPath = socketPath(sessDir);
    });

    afterEach(async () => {
      destroySession(testHome, sessionId);
      await cleanupHome(testHome);
      sessDir = '';
      sessionId = '';
      rpcSocketPath = '';
      testHome = '';
    });

    async function restartSession(
      command: string[],
      marker: string,
    ): Promise<void> {
      destroySession(testHome, sessionId);
      sessionId = createSession(testHome, command);
      await waitForOutputMarker(testHome, sessionId, marker);
      sessDir = sessionDir(testHome, sessionId);
      rpcSocketPath = socketPath(sessDir);
    }

    it('returns structured snapshots over RPC', async () => {
      const result = (await sendRpc(
        rpcSocketPath,
        'snapshot',
        { format: 'structured' },
        SNAPSHOT_TIMEOUT_MS,
      )) as SnapshotResult;

      expect(result.format).toBe('structured');
      expect(result.sessionId).toBe(sessionId);

      if (result.format !== 'structured') {
        throw new Error('expected structured snapshot result');
      }

      expect(Array.isArray(result.visibleLines)).toBe(true);
      expect(
        result.visibleLines.some((line) => line.text.includes(OUTPUT_MARKER)),
      ).toBe(true);

      const filename = snapshotFilename(result.capturedAtSeq, 'structured');
      const manifest = await readArtifactManifest(sessDir);
      const artifactContents = JSON.parse(
        await readFile(artifactPath(sessDir, filename), 'utf8'),
      ) as SnapshotResult;

      expect(artifactContents).toEqual(result);
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]).toMatchObject({
        kind: 'snapshot',
        filename,
        sessionId,
        capturedAtSeq: result.capturedAtSeq,
      });
      expect(manifest.artifacts[0]?.metadata).toEqual(
        expect.objectContaining({
          format: 'structured',
          cols: result.cols,
          rows: result.rows,
          cursorRow: result.cursorRow,
          cursorCol: result.cursorCol,
          rendererBackend: 'ghostty-web',
        }),
      );
    });

    it('returns text snapshots over RPC', async () => {
      const result = (await sendRpc(
        rpcSocketPath,
        'snapshot',
        { format: 'text' },
        SNAPSHOT_TIMEOUT_MS,
      )) as SnapshotResult;

      expect(result.format).toBe('text');
      expect(result.sessionId).toBe(sessionId);

      if (result.format !== 'text') {
        throw new Error('expected text snapshot result');
      }

      expect(result.text).toContain(OUTPUT_MARKER);

      const filename = snapshotFilename(result.capturedAtSeq, 'text');
      const manifest = await readArtifactManifest(sessDir);
      const artifactContents = JSON.parse(
        await readFile(artifactPath(sessDir, filename), 'utf8'),
      ) as SnapshotResult;

      expect(artifactContents).toEqual(result);
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]).toMatchObject({
        kind: 'snapshot',
        filename,
        sessionId,
        capturedAtSeq: result.capturedAtSeq,
      });
      expect(manifest.artifacts[0]?.metadata).toEqual(
        expect.objectContaining({
          format: 'text',
          cols: result.cols,
          rows: result.rows,
          cursorRow: result.cursorRow,
          cursorCol: result.cursorCol,
          rendererBackend: 'ghostty-web',
        }),
      );
    });

    it('defaults snapshot RPCs to structured format', async () => {
      const result = (await sendRpc(
        rpcSocketPath,
        'snapshot',
        {},
        SNAPSHOT_TIMEOUT_MS,
      )) as SnapshotResult;

      expect(result.format).toBe('structured');

      if (result.format !== 'structured') {
        throw new Error('expected structured snapshot result');
      }

      expect(
        result.visibleLines.some((line) => line.text.includes(OUTPUT_MARKER)),
      ).toBe(true);
    });

    it('supports includeScrollback snapshot RPCs for overflow output', async () => {
      await restartSession(
        [
          '/bin/sh',
          '-c',
          'for i in $(seq 1 50); do echo line-$i; done; exec cat',
        ],
        SCROLLBACK_OUTPUT_MARKER,
      );

      const result = (await sendRpc(
        rpcSocketPath,
        'snapshot',
        { format: 'structured', includeScrollback: true },
        SNAPSHOT_TIMEOUT_MS,
      )) as SnapshotResult;

      expect(result.format).toBe('structured');
      if (result.format !== 'structured') {
        throw new Error('expected structured snapshot result');
      }

      expect(result.visibleLines).not.toHaveLength(0);
      expect(
        result.visibleLines.some((line) => line.text.includes('line-50')),
      ).toBe(true);

      const filename = snapshotFilename(result.capturedAtSeq, 'structured');
      const manifest = await readArtifactManifest(sessDir);
      expect(manifest.artifacts).toHaveLength(1);

      expect(result.scrollbackLines).toBeDefined();
      const scrollbackLines = result.scrollbackLines;
      if (scrollbackLines !== undefined) {
        expect(scrollbackLines).not.toHaveLength(0);
        expect(scrollbackLines[0]?.row).toBe(0);
        for (let index = 1; index < scrollbackLines.length; index += 1) {
          expect(scrollbackLines[index]?.row).toBeGreaterThan(
            scrollbackLines[index - 1]?.row ?? -1,
          );
        }
        expect(manifest.artifacts[0]).toMatchObject({
          kind: 'snapshot',
          filename,
          sessionId,
          capturedAtSeq: result.capturedAtSeq,
        });
        expect(manifest.artifacts[0]?.metadata).toEqual(
          expect.objectContaining({
            format: 'structured',
            cols: result.cols,
            rows: result.rows,
            cursorRow: result.cursorRow,
            cursorCol: result.cursorCol,
            rendererBackend: 'ghostty-web',
            scrollbackLineCount: scrollbackLines.length,
          }),
        );
        return;
      }

      expect(manifest.artifacts[0]).toMatchObject({
        kind: 'snapshot',
        filename,
        sessionId,
        capturedAtSeq: result.capturedAtSeq,
      });
      expect(manifest.artifacts[0]?.metadata).toEqual(
        expect.objectContaining({
          format: 'structured',
          cols: result.cols,
          rows: result.rows,
          cursorRow: result.cursorRow,
          cursorCol: result.cursorCol,
          rendererBackend: 'ghostty-web',
        }),
      );
      expect(manifest.artifacts[0]?.metadata).not.toHaveProperty(
        'scrollbackLineCount',
      );
    });

    it('omits scrollback from structured snapshot RPCs by default', async () => {
      const result = (await sendRpc(
        rpcSocketPath,
        'snapshot',
        { format: 'structured' },
        SNAPSHOT_TIMEOUT_MS,
      )) as SnapshotResult;

      expect(result.format).toBe('structured');
      if (result.format !== 'structured') {
        throw new Error('expected structured snapshot result');
      }

      expect(result.scrollbackLines).toBeUndefined();

      const manifest = await readArtifactManifest(sessDir);
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]?.metadata).not.toHaveProperty(
        'scrollbackLineCount',
      );
    });

    it('captures screenshots with the default render profile', async () => {
      const result = (await sendRpc(
        rpcSocketPath,
        'screenshot',
        {},
        SNAPSHOT_TIMEOUT_MS,
      )) as ScreenshotResult;
      const fileStats = await stat(result.artifactPath);
      const filename = screenshotFilename(
        result.capturedAtSeq,
        result.profileName,
      );
      const manifest = await readArtifactManifest(sessDir);

      expect(result.sessionId).toBe(sessionId);
      expect(result.profileName).toBe('reference-dark');
      expect(result.artifactPath).toBe(artifactPath(sessDir, filename));
      expect(result.pngSizeBytes).toBeGreaterThan(0);
      expect(fileStats.size).toBe(result.pngSizeBytes);
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]).toMatchObject({
        kind: 'screenshot',
        filename,
        sessionId,
        capturedAtSeq: result.capturedAtSeq,
        metadata: {
          profileName: result.profileName,
          cols: result.cols,
          rows: result.rows,
          pngSizeBytes: result.pngSizeBytes,
        },
      });
    });

    it('handles concurrent snapshot and screenshot requests', async () => {
      const [snapshot, screenshot] = (await Promise.all([
        sendRpc(
          rpcSocketPath,
          'snapshot',
          { format: 'structured' },
          SNAPSHOT_TIMEOUT_MS,
        ),
        sendRpc(rpcSocketPath, 'screenshot', {}, SNAPSHOT_TIMEOUT_MS),
      ])) as [SnapshotResult, ScreenshotResult];
      const screenshotStats = await stat(screenshot.artifactPath);
      const manifest = await readArtifactManifest(sessDir);

      expect(snapshot.sessionId).toBe(sessionId);
      expect(snapshot.format).toBe('structured');
      if (snapshot.format !== 'structured') {
        throw new Error('expected structured snapshot result');
      }
      expect(
        snapshot.visibleLines.some((line) => line.text.includes(OUTPUT_MARKER)),
      ).toBe(true);

      expect(screenshot.sessionId).toBe(sessionId);
      expect(screenshot.profileName).toBe('reference-dark');
      expect(screenshot.pngSizeBytes).toBeGreaterThan(0);
      expect(screenshotStats.size).toBe(screenshot.pngSizeBytes);

      expect(manifest.artifacts).toHaveLength(2);
      expect(manifest.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'snapshot',
            filename: snapshotFilename(snapshot.capturedAtSeq, 'structured'),
            sessionId,
            capturedAtSeq: snapshot.capturedAtSeq,
          }),
          expect.objectContaining({
            kind: 'screenshot',
            filename: screenshotFilename(
              screenshot.capturedAtSeq,
              screenshot.profileName,
            ),
            sessionId,
            capturedAtSeq: screenshot.capturedAtSeq,
          }),
        ]),
      );
    });

    it('captures screenshots with an explicit render profile', async () => {
      const result = (await sendRpc(
        rpcSocketPath,
        'screenshot',
        { profile: 'reference-light' },
        SNAPSHOT_TIMEOUT_MS,
      )) as ScreenshotResult;
      const fileStats = await stat(result.artifactPath);
      const filename = screenshotFilename(
        result.capturedAtSeq,
        result.profileName,
      );
      const manifest = await readArtifactManifest(sessDir);

      expect(result.sessionId).toBe(sessionId);
      expect(result.profileName).toBe('reference-light');
      expect(result.artifactPath).toBe(artifactPath(sessDir, filename));
      expect(result.pngSizeBytes).toBeGreaterThan(0);
      expect(fileStats.size).toBe(result.pngSizeBytes);
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0]).toMatchObject({
        kind: 'screenshot',
        filename,
        sessionId,
        capturedAtSeq: result.capturedAtSeq,
        metadata: {
          profileName: result.profileName,
          cols: result.cols,
          rows: result.rows,
          pngSizeBytes: result.pngSizeBytes,
        },
      });
    });
  },
);
