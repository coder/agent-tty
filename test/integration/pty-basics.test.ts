import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  inspectSession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';

describe('pty-basics integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-home-'));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('type writes and records input_text', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const typeResult = runCli(['type', sessionId, 'hello', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');
      const envelope = JSON.parse(typeResult.stdout) as SuccessEnvelope<
        Record<string, never>
      >;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputTextEvents = events.filter(
        (event) => event.type === 'input_text',
      );
      expect(inputTextEvents.length).toBeGreaterThan(0);
      expect(inputTextEvents[0]?.payload.data).toBe('hello');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('type reads input from --file and records input_text', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const inputPath = join(testHome, 'type-input.txt');
      await writeFile(inputPath, 'hello-from-file');

      const typeResult = runCli(['type', sessionId, '--file', inputPath, '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');
      const envelope = JSON.parse(typeResult.stdout) as SuccessEnvelope<
        Record<string, never>
      >;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputTextEvents = events.filter(
        (event) => event.type === 'input_text',
      );
      expect(inputTextEvents.length).toBeGreaterThan(0);
      expect(inputTextEvents[0]?.payload.data).toBe('hello-from-file');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('send-keys Enter records input_keys', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const sendKeysResult = runCli(
        ['send-keys', sessionId, 'Enter', '--json'],
        {
          AGENT_TERMINAL_HOME: testHome,
        },
      );
      expect(sendKeysResult.status).toBe(0);
      expect(sendKeysResult.stderr).toBe('');
      const envelope = JSON.parse(sendKeysResult.stdout) as SuccessEnvelope<
        Record<string, never>
      >;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputKeyEvents = events.filter(
        (event) => event.type === 'input_keys',
      );
      expect(inputKeyEvents.length).toBeGreaterThan(0);
      expect(inputKeyEvents[0]?.payload.keys).toEqual(['Enter']);
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('paste records input_paste with bracketed paste markers', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const pasteResult = runCli(['paste', sessionId, 'test-text', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(pasteResult.status).toBe(0);
      expect(pasteResult.stderr).toBe('');
      const envelope = JSON.parse(pasteResult.stdout) as SuccessEnvelope<
        Record<string, never>
      >;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputPasteEvents = events.filter(
        (event) => event.type === 'input_paste',
      );
      expect(inputPasteEvents.length).toBeGreaterThan(0);

      const data = inputPasteEvents[0]?.payload.data;
      expect(typeof data).toBe('string');
      expect(data).toContain('\u001b[200~');
      expect(data).toContain('test-text');
      expect(data).toContain('\u001b[201~');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('paste reads input from --file and records input_paste with bracketed paste markers', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const inputPath = join(testHome, 'paste-input.txt');
      await writeFile(inputPath, 'paste-from-file');

      const pasteResult = runCli(
        ['paste', sessionId, '--file', inputPath, '--json'],
        {
          AGENT_TERMINAL_HOME: testHome,
        },
      );
      expect(pasteResult.status).toBe(0);
      expect(pasteResult.stderr).toBe('');
      const envelope = JSON.parse(pasteResult.stdout) as SuccessEnvelope<
        Record<string, never>
      >;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputPasteEvents = events.filter(
        (event) => event.type === 'input_paste',
      );
      expect(inputPasteEvents.length).toBeGreaterThan(0);

      const data = inputPasteEvents[0]?.payload.data;
      expect(typeof data).toBe('string');
      expect(data).toContain('[200~');
      expect(data).toContain('paste-from-file');
      expect(data).toContain('[201~');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('resize records resize and inspect reflects new dimensions', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const resizeResult = runCli(
        ['resize', sessionId, '--cols', '120', '--rows', '40', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
      );
      expect(resizeResult.status).toBe(0);
      expect(resizeResult.stderr).toBe('');
      const envelope = JSON.parse(resizeResult.stdout) as SuccessEnvelope<{
        cols: number;
        rows: number;
      }>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result).toEqual({ cols: 120, rows: 40 });

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const resizeEvents = events.filter((event) => event.type === 'resize');
      expect(resizeEvents.length).toBeGreaterThan(0);
      expect(resizeEvents[0]?.payload).toEqual({ cols: 120, rows: 40 });

      const session = inspectSession(testHome, sessionId);
      expect(session.cols).toBe(120);
      expect(session.rows).toBe(40);
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
