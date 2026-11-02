import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScreenshotResult } from '../../src/protocol/messages.js';
import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import { sessionDir } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

const MARKER = 'screenshot-out-proof';
const CLI_TIMEOUT_MS = 60_000;

interface ErrorEnvelope {
  ok: false;
  error: { code: string; details?: Record<string, unknown> };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('screenshot --out', { timeout: 120_000 }, () => {
  let testHome = '';
  let outDir = '';
  let sessionId = '';

  function screenshot(args: string[]): {
    status: number | null;
    envelope: SuccessEnvelope<ScreenshotResult> | ErrorEnvelope;
  } {
    const result = runCli(
      ['screenshot', sessionId, ...args, '--json'],
      { AGENT_TTY_HOME: testHome },
      CLI_TIMEOUT_MS,
    );
    expect(result.stderr).toBe('');
    return {
      status: result.status,
      envelope: JSON.parse(result.stdout) as
        | SuccessEnvelope<ScreenshotResult>
        | ErrorEnvelope,
    };
  }

  function expectSuccess(run: ReturnType<typeof screenshot>): ScreenshotResult {
    expect(run.status).toBe(0);
    expect(run.envelope.ok).toBe(true);
    return (run.envelope as SuccessEnvelope<ScreenshotResult>).result;
  }

  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-screenshot-out-home-')));
    // oxfmt-ignore
    outDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-screenshot-out-')));
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      `echo ${MARKER}; exec cat`,
    ]);
    const wait = runCli(
      ['wait', sessionId, '--text', MARKER, '--timeout-ms', '20000', '--json'],
      { AGENT_TTY_HOME: testHome },
      CLI_TIMEOUT_MS,
    );
    expect(wait.status).toBe(0);
  }, 60_000);

  afterEach(async () => {
    destroySession(testHome, sessionId);
    await cleanupHome(testHome);
    await rm(outDir, { recursive: true, force: true });
    sessionId = '';
    testHome = '';
    outDir = '';
  });

  it('writes the PNG to --out, records the artifact and returns the path', async () => {
    const out = join(outDir, 'proof.png');

    const result = expectSuccess(screenshot(['--out', out]));

    expect(result.artifactPath).toBe(out);
    const bytes = await readFile(out);
    expect(sha256(bytes)).toBe(result.sha256);
    expect(bytes.byteLength).toBe(result.pngSizeBytes);
    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      kind: 'screenshot',
      sha256: result.sha256,
    });
  });

  it('resolves a relative --out against the working directory and replaces an existing file', async () => {
    const out = join(outDir, 'relative.png');
    await writeFile(out, 'stale');

    const result = expectSuccess(
      screenshot(['--out', relative(process.cwd(), out)]),
    );

    expect(result.artifactPath).toBe(out);
    expect(sha256(await readFile(out))).toBe(result.sha256);
  });

  it('fails with EXPORT_ERROR before capturing when the --out parent folder is missing', async () => {
    const out = join(outDir, 'missing', 'proof.png');

    const run = screenshot(['--out', out]);

    expect(run.status).toBe(7);
    expect(run.envelope.ok).toBe(false);
    expect((run.envelope as ErrorEnvelope).error).toMatchObject({
      code: 'EXPORT_ERROR',
      details: { sessionId, out },
    });
    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.artifacts).toEqual([]);
  });

  it('refuses an --out inside session storage and leaves the managed files as they were', async () => {
    const first = expectSuccess(screenshot([]));
    const before = await readFile(first.artifactPath);

    const run = screenshot(['--out', first.artifactPath]);

    expect(run.status).toBe(7);
    expect((run.envelope as ErrorEnvelope).error.code).toBe('EXPORT_ERROR');
    expect((await readFile(first.artifactPath)).equals(before)).toBe(true);
    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.artifacts).toHaveLength(1);
  });

  it('writes --out for a destroyed session through offline replay', async () => {
    destroySession(testHome, sessionId);
    const out = join(outDir, 'offline.png');

    const result = expectSuccess(screenshot(['--out', out]));

    expect(result.artifactPath).toBe(out);
    expect(sha256(await readFile(out))).toBe(result.sha256);
  });
});
