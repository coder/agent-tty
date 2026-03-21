import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDoctorLines,
  runArtifactAtomicityCheck,
  runDoctorCheck,
  runDoctorChecks,
  runEventLogWritabilityCheck,
  runHomeWritableCheck,
  runPtySpawnCheck,
  runSocketViabilityCheck,
  type DoctorDependencies,
} from '../../../src/cli/commands/doctor.js';

const QUICK_TIMEOUT_MS = 5_000;

const NEW_DOCTOR_CHECKS = [
  { name: 'home-writable', run: () => runHomeWritableCheck() },
  { name: 'pty-spawn', run: () => runPtySpawnCheck() },
  { name: 'socket-viable', run: () => runSocketViabilityCheck() },
  {
    name: 'artifact-atomicity',
    run: () => runArtifactAtomicityCheck(),
  },
  {
    name: 'event-log-writable',
    run: () => runEventLogWritabilityCheck(),
  },
] as const;

const BROKEN_DOCTOR_CHECKS = [
  {
    name: 'home-writable',
    expectedMessage: 'home not writable',
    run: () =>
      runHomeWritableCheck({
        writeFile: (() =>
          Promise.reject(new Error('home not writable'))) as DoctorDependencies['writeFile'],
      }),
  },
  {
    name: 'pty-spawn',
    expectedMessage: 'pty unavailable',
    run: () =>
      runPtySpawnCheck({
        createPty: (() => {
          throw new Error('pty unavailable');
        }) as DoctorDependencies['createPty'],
      }),
  },
  {
    name: 'socket-viable',
    expectedMessage: 'socket unavailable',
    run: () =>
      runSocketViabilityCheck({
        createSocketServer: (() => {
          throw new Error('socket unavailable');
        }) as DoctorDependencies['createSocketServer'],
      }),
  },
  {
    name: 'artifact-atomicity',
    expectedMessage: 'rename unavailable',
    run: () =>
      runArtifactAtomicityCheck({
        rename: (() =>
          Promise.reject(new Error('rename unavailable'))) as DoctorDependencies['rename'],
      }),
  },
  {
    name: 'event-log-writable',
    expectedMessage: 'append unavailable',
    run: () =>
      runEventLogWritabilityCheck({
        writeFile: (() =>
          Promise.reject(new Error('append unavailable'))) as DoctorDependencies['writeFile'],
      }),
  },
] as const;

let testHome = '';

describe('doctor command', () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-doctor-home-'));
    process.env.AGENT_TERMINAL_HOME = testHome;
  });

  afterEach(async () => {
    delete process.env.AGENT_TERMINAL_HOME;
    await rm(testHome, { recursive: true, force: true });
    testHome = '';
  });

  it('returns unique passing checks across environment and renderer groups', async () => {
    const result = await runDoctorChecks();
    const allChecks = [...result.checks.environment, ...result.checks.renderer];
    const checkNames = allChecks.map((check) => check.name);

    expect(result.ok).toBe(true);
    expect(result.checks.environment.length).toBeGreaterThan(0);
    expect(result.checks.renderer.length).toBeGreaterThan(0);
    expect(checkNames).toEqual(
      expect.arrayContaining([
        'home-writable',
        'pty-spawn',
        'socket-viable',
        'artifact-atomicity',
        'event-log-writable',
      ]),
    );
    expect(new Set(checkNames).size).toBe(checkNames.length);
    expect(allChecks.every((check) => check.status === 'pass')).toBe(true);
    expect(
      allChecks.every((check) => typeof check.durationMs === 'number'),
    ).toBe(true);
  });

  it.each(NEW_DOCTOR_CHECKS)(
    'passes $name in a healthy environment',
    async ({ name, run }) => {
      const result = await runDoctorCheck(name, run, QUICK_TIMEOUT_MS);

      expect(result).toMatchObject({
        name,
        status: 'pass',
      });
      expect(result.message.length).toBeGreaterThan(0);
    },
  );

  it.each(BROKEN_DOCTOR_CHECKS)(
    'fails $name gracefully when its dependency is broken',
    async ({ name, expectedMessage, run }) => {
      const result = await runDoctorCheck(name, run, QUICK_TIMEOUT_MS);

      expect(result).toMatchObject({
        name,
        status: 'fail',
      });
      expect(result.message).toContain(expectedMessage);
    },
  );

  it('formats grouped human-readable output', () => {
    const lines = buildDoctorLines({
      ok: false,
      checks: {
        environment: [
          {
            name: 'node-runtime',
            status: 'pass',
            message: 'Node v24.1.0 ok',
            durationMs: 1,
          },
        ],
        renderer: [
          {
            name: 'playwright_available',
            status: 'fail',
            message: 'playwright missing',
            durationMs: 2,
          },
          {
            name: 'screenshot_viable',
            status: 'skip',
            message: 'not attempted',
            durationMs: 3,
          },
        ],
      },
    });

    expect(lines).toEqual([
      'Environment:',
      '  ✓ node: Node v24.1.0 ok',
      '',
      'Renderer:',
      '  ✗ playwright: playwright missing',
      '  ○ screenshot: not attempted',
    ]);
  });
});
