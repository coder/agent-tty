import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type SuccessEnvelope } from '../helpers.js';
import type { CommandErrorEnvelope } from '../../src/protocol/envelope.js';

let testHome = '';

function testEnv(): Record<string, string> {
  return { AGENT_TERMINAL_HOME: testHome };
}

function parseErrorEnvelope(output: string): CommandErrorEnvelope {
  return JSON.parse(output) as CommandErrorEnvelope;
}

describe('CLI integration', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'agent-terminal-cli-home-'));
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    testHome = '';
  });

  it('prints a JSON envelope for version', () => {
    const result = runCli(['version', '--json'], testEnv());
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      cliVersion: string;
    }>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('version');
    expect(parsed.result.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects type input when positional text and --file are both provided', () => {
    const inputPath = join(testHome, 'type-input.txt');
    writeFileSync(inputPath, 'from-file');

    const result = runCli(
      ['type', 'session-01', 'inline-text', '--file', inputPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('rejects type input when neither positional text nor --file is provided', () => {
    const result = runCli(['type', 'session-01', '--json'], testEnv());

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain(
      'Provide either a positional <text> argument or --file <path>.',
    );
  });

  it('rejects a missing type input file', () => {
    const missingPath = join(testHome, 'missing-type.txt');

    const result = runCli(
      ['type', 'session-01', '--file', missingPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('was not found');
  });

  it('rejects paste input when positional text and --file are both provided', () => {
    const inputPath = join(testHome, 'paste-input.txt');
    writeFileSync(inputPath, 'from-file');

    const result = runCli(
      ['paste', 'session-01', 'inline-text', '--file', inputPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('rejects paste input when neither positional text nor --file is provided', () => {
    const result = runCli(['paste', 'session-01', '--json'], testEnv());

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain(
      'Provide either a positional <text> argument or --file <path>.',
    );
  });

  it('rejects an empty paste input file', () => {
    const inputPath = join(testHome, 'empty-paste.txt');
    writeFileSync(inputPath, '');

    const result = runCli(
      ['paste', 'session-01', '--file', inputPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('must not be empty');
  });

  it('prints a JSON envelope for doctor including the new health checks', () => {
    const result = runCli(['doctor', '--json'], testEnv());
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      ok: boolean;
      checks: {
        environment: Array<{ name: string; status: string }>;
        renderer: Array<{ name: string; status: string }>;
      };
    }>;

    const allChecks = [
      ...parsed.result.checks.environment,
      ...parsed.result.checks.renderer,
    ];

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('doctor');
    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.checks.environment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'home-writable', status: 'pass' }),
        expect.objectContaining({ name: 'pty-spawn', status: 'pass' }),
        expect.objectContaining({ name: 'socket-viable', status: 'pass' }),
        expect.objectContaining({
          name: 'artifact-atomicity',
          status: 'pass',
        }),
        expect.objectContaining({
          name: 'event-log-writable',
          status: 'pass',
        }),
      ]),
    );
    expect(parsed.result.checks.renderer.length).toBeGreaterThan(0);
    expect(allChecks.every((check) => check.status === 'pass')).toBe(true);
  });
});
