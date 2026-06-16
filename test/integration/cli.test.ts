import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type SuccessEnvelope } from '../helpers.js';
import type { CommandErrorEnvelope } from '../../src/protocol/envelope.js';
import {
  SkillGetResultSchema,
  SkillListResultSchema,
  SkillPathResultSchema,
} from '../../src/skills/index.js';

interface ErrorEnvelope {
  ok: false;
  command: string;
  timestamp: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

let testHome = '';

function testEnv(): Record<string, string> {
  return { AGENT_TTY_HOME: testHome };
}

function parseErrorEnvelope(output: string): CommandErrorEnvelope {
  return JSON.parse(output) as CommandErrorEnvelope;
}

function readBundledSkill(name: string): string {
  return readFileSync(join('skill-data', name, 'SKILL.md'), 'utf8');
}

const SEMVER_WITH_OPTIONAL_PRERELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('CLI integration', () => {
  beforeEach(() => {
    // oxfmt-ignore
    testHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-cli-home-')));
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
      rendererBackends: string[];
    }>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('version');
    expect(parsed.result.cliVersion).toMatch(SEMVER_WITH_OPTIONAL_PRERELEASE);
    expect(parsed.result.rendererBackends).toEqual([
      'ghostty-web',
      'libghostty-vt',
    ]);
  });

  it('lists bundled skills in human output', () => {
    const result = runCli(['skills', 'list'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('agent-tty');
    expect(result.stdout).toContain('dogfood-tui');
  });

  it('prints a JSON envelope for skills list', () => {
    const result = runCli(['skills', 'list', '--json'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('skills list');
    expect(SkillListResultSchema.safeParse(parsed.result).success).toBe(true);
    expect(SkillListResultSchema.parse(parsed.result).skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'agent-tty' }),
        expect.objectContaining({ name: 'dogfood-tui' }),
      ]),
    );
  });

  it('prints the requested bundled skill verbatim', () => {
    const result = runCli(['skills', 'get', 'agent-tty'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(readBundledSkill('agent-tty'));
  });

  it('prints a JSON envelope for skills get', () => {
    const result = runCli(['skills', 'get', 'agent-tty', '--json'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('skills get');
    expect(SkillGetResultSchema.safeParse(parsed.result).success).toBe(true);
    expect(SkillGetResultSchema.parse(parsed.result).content).toBe(
      readBundledSkill('agent-tty'),
    );
  });

  it('reports SKILL_NOT_FOUND for unknown skills', () => {
    const result = runCli(['skills', 'get', 'nonexistent'], testEnv());

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SKILL_NOT_FOUND: Skill not found.');
  });

  it('prints the bundled skill directory path', () => {
    const result = runCli(['skills', 'path', 'agent-tty'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('skill-data/agent-tty');
  });

  it('prints a JSON envelope for skills path', () => {
    const result = runCli(['skills', 'path', 'agent-tty', '--json'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('skills path');
    expect(SkillPathResultSchema.safeParse(parsed.result).success).toBe(true);
    expect(SkillPathResultSchema.parse(parsed.result).path).toContain(
      'skill-data/agent-tty',
    );
  });

  it('makes the bundled skill guidance prominent and discoverable in top-level help', () => {
    const result = runCli(['--help'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.startsWith('MANDATORY FOR CODING AGENTS:')).toBe(true);
    expect(result.stdout).toContain(
      'If your agent already loaded that skill, follow it; otherwise run `agent-tty skills get agent-tty` before any other agent-tty command.',
    );
    expect(result.stdout).toMatch(/\n {2}skills\s+Manage built-in skills\n/u);
    expect(result.stdout).not.toContain('skill [options]');
    expect(result.stdout).not.toContain('`agent-tty skill`');
    expect(result.stdout).toContain(
      'Coding agents: after loading the core `agent-tty` skill, run `agent-tty skills list` to discover other bundled skills and `agent-tty skills get <name>` to load one.',
    );
  });

  it('rejects the removed singular skill command', () => {
    const result = runCli(['skill'], testEnv());

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'skill'");
    expect(result.stderr).toContain('(Did you mean skills?)');
  });

  it('resolves the `d` alias to the dashboard command', () => {
    // `--help` exits before the action runs, so this exercises alias
    // resolution without needing an interactive TTY or the libghostty-vt
    // renderer that the dashboard otherwise requires.
    const result = runCli(['d', '--help'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'Watch what your agents are doing in their shells',
    );
  });

  it('resolves the `ls` alias to the list command', () => {
    // `--help` exits before the action runs, so this exercises alias
    // resolution without touching the Home Registry or reconciling sessions.
    const result = runCli(['ls', '--help'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('List sessions');
  });

  it('accepts --append-newline for type', () => {
    const result = runCli(
      ['type', 'session-01', 'hello', '--append-newline', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
    expect(envelope.error.message).toContain('session-01');
  });

  it('rejects type input when positional text and --file are both provided', () => {
    const inputPath = join(testHome, 'type-input.txt');
    writeFileSync(inputPath, 'from-file');

    const result = runCli(
      ['type', 'session-01', 'inline-text', '--file', inputPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('rejects type input when neither positional text nor --file is provided', () => {
    const result = runCli(['type', 'session-01', '--json'], testEnv());

    expect(result.status).toBe(2);
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

    expect(result.status).toBe(2);
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

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('rejects paste input when neither positional text nor --file is provided', () => {
    const result = runCli(['paste', 'session-01', '--json'], testEnv());

    expect(result.status).toBe(2);
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

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('must not be empty');
  });

  it('rejects screenshot requests when --show-cursor and --hide-cursor are both provided', () => {
    const result = runCli(
      ['screenshot', 'session-01', '--show-cursor', '--hide-cursor', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('returns SESSION_NOT_FOUND for resize before validating dimensions', () => {
    const result = runCli(
      ['resize', 'missing-session', '--cols', '0', '--rows', '0', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('resize');
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
    expect(envelope.error.message).toBe(
      'Session "missing-session" was not found.',
    );
  });

  it('returns SESSION_NOT_FOUND for signal before validating the signal name', () => {
    const result = runCli(
      ['signal', 'missing-session', 'BAD', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('signal');
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
    expect(envelope.error.message).toBe(
      'Session "missing-session" was not found.',
    );
  });

  it('rejects empty run text before resolving the command target', () => {
    const result = runCli(['run', 'missing-session', '', '--json'], testEnv());

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = parseErrorEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe('run');
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toBe('Text must not be empty.');
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

  it('uses --home instead of AGENT_TTY_HOME', () => {
    // oxfmt-ignore
    const overrideHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-cli-override-')));

    try {
      const result = runCli(
        [
          '--home',
          overrideHome,
          'create',
          '--json',
          '--',
          '/bin/sh',
          '-c',
          'exit 0',
        ],
        testEnv(),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');

      const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
        sessionId: string;
      }>;
      const sessionManifest = join(
        overrideHome,
        'sessions',
        parsed.result.sessionId,
        'session.json',
      );
      const envManifest = join(
        testHome,
        'sessions',
        parsed.result.sessionId,
        'session.json',
      );

      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('create');
      expect(existsSync(sessionManifest)).toBe(true);
      expect(existsSync(envManifest)).toBe(false);
    } finally {
      rmSync(overrideHome, { recursive: true, force: true });
    }
  });

  it('maps missing sessions to exit code 3 and preserves JSON error envelopes', () => {
    const result = runCli(['inspect', 'missing-session', '--json'], testEnv());
    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as ErrorEnvelope;

    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe('inspect');
    expect(parsed.error.code).toBe('SESSION_NOT_FOUND');
    expect(parsed.error.message).toContain('missing-session');
  });

  it('accepts --log-level as a root flag', () => {
    const result = runCli(
      ['--log-level', 'debug', 'version', '--json'],
      testEnv(),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toBe('');
    expect(result.stderr).toContain(
      '[agent-tty] debug: resolved command context',
    );

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      cliVersion: string;
    }>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('version');
  });

  it('accepts --profile as a root flag', () => {
    const result = runCli(
      ['--profile', 'my-profile', 'version', '--json'],
      testEnv(),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as SuccessEnvelope<{
      cliVersion: string;
    }>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('version');
  });

  it('rejects invalid --log-level values', () => {
    const result = runCli(
      ['--log-level', 'bogus', 'version', '--json'],
      testEnv(),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as ErrorEnvelope;

    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe('agent-tty');
    expect(parsed.error.code).toBe('INVALID_INPUT');
    expect(parsed.error.message).toBe(
      'Log level must be one of debug, info, warn, or error.',
    );
  });

  it('maps invalid root options to exit code 2', () => {
    const result = runCli(
      ['--home', 'relative/path', 'version', '--json'],
      testEnv(),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(result.stdout) as ErrorEnvelope;

    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe('agent-tty');
    expect(parsed.error.code).toBe('INVALID_INPUT');
    expect(parsed.error.message).toBe('--home must be an absolute path.');
  });

  it('keeps human output free of ANSI sequences when --no-color is set', () => {
    const result = runCli(['--no-color', 'version'], testEnv());
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('agent-tty');
    expect(result.stdout).not.toContain('\u001b[');
  });
});
