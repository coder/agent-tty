import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildSkillResult } from '../../../src/cli/commands/skill.js';
import { buildVersionResult } from '../../../src/cli/commands/version.js';
import {
  createErrorEnvelope,
  createSuccessEnvelope,
} from '../../../src/protocol/envelope.js';
import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';
import {
  CapabilityEntrySchema,
  DestroyResultSchema,
  InspectResultSchema,
  RecordExportResultSchema,
  RunResultSchema,
  ScreenshotResultSchema,
  SendKeysResultSchema,
  SnapshotResultSchema,
  WaitForRenderResultSchema,
  WaitResultSchema,
} from '../../../src/protocol/messages.js';

const LOCKED_TIMESTAMP = '2026-03-25T15:00:00.000Z';
const NonEmptyStringSchema = z.string().min(1);
const IsoDatetimeSchema = z.iso.datetime();
const PositiveIntSchema = z.number().int().positive();

const VersionResultSchema = z
  .object({
    cliVersion: z.string().min(1),
    protocolVersion: z.string().min(1),
    rendererBackends: z.array(z.string().min(1)),
    runtime: z
      .object({
        node: z.string().min(1),
        platform: z.string().min(1),
        arch: z.string().min(1),
      })
      .strict(),
    capabilities: z.array(CapabilityEntrySchema).optional(),
  })
  .strict();

const SkillResultSchema = z
  .object({
    name: z.literal('agent-terminal'),
    source: z.literal('packaged-file'),
    content: z.string().min(1),
  })
  .strict();

// CreateResultSchema is defined locally because create does not go through
// the RPC layer — it constructs the result from the session manifest.
// This schema acts as the golden contract lock for the create result shape.
// If a protocol-level CreateResultSchema is added later, replace this.
const CreateResultSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    createdAt: IsoDatetimeSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    shell: NonEmptyStringSchema,
    env: z.record(NonEmptyStringSchema, z.string()).optional(),
    idleTimeoutMs: PositiveIntSchema.optional(),
  })
  .strict();

// SessionSummarySchema is defined locally because list returns session summaries
// assembled from manifests rather than a shared protocol export. This schema
// locks the expected per-session list payload used by the local ListResultSchema.
// If a protocol-level SessionSummarySchema is added later, replace this.
const SessionSummarySchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    status: NonEmptyStringSchema,
    command: z.array(NonEmptyStringSchema).min(1),
    createdAt: IsoDatetimeSchema,
    name: NonEmptyStringSchema.optional(),
    pid: z.number().int().nullable(),
  })
  .strict();

// ListResultSchema is defined locally because list does not go through the
// RPC layer — it constructs the result from session manifests and summaries.
// This schema acts as the golden contract lock for the list result shape.
// If a protocol-level ListResultSchema is added later, replace this.
const ListResultSchema = z
  .object({
    sessions: z.array(SessionSummarySchema),
  })
  .strict();

const DoctorCheckStatusSchema = z.enum(['pass', 'fail', 'skip']);
const EnvironmentDoctorCheckNameSchema = z.enum([
  'node-runtime',
  'cwd-access',
  'temp-dir',
  'home_isolation',
  'home-writable',
  'pty-spawn',
  'socket-viable',
  'artifact-atomicity',
  'event-log-writable',
]);
const RendererDoctorCheckNameSchema = z.enum([
  'playwright_available',
  'browser_cache_accessible',
  'browser_launch',
  'ghostty_web_available',
  'screenshot_viable',
]);

const DoctorCheckSchema = z
  .object({
    name: z.string().min(1),
    status: DoctorCheckStatusSchema,
    message: z.string(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const EnvironmentDoctorCheckSchema = DoctorCheckSchema.extend({
  name: EnvironmentDoctorCheckNameSchema,
});
const RendererDoctorCheckSchema = DoctorCheckSchema.extend({
  name: RendererDoctorCheckNameSchema,
});

const DoctorResultSchema = z
  .object({
    ok: z.boolean(),
    checks: z
      .object({
        environment: z
          .array(EnvironmentDoctorCheckSchema)
          .length(EnvironmentDoctorCheckNameSchema.options.length),
        renderer: z
          .array(RendererDoctorCheckSchema)
          .length(RendererDoctorCheckNameSchema.options.length),
      })
      .strict(),
    capabilities: z.array(CapabilityEntrySchema),
  })
  .strict();

const GcSkippedSessionSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    reason: z.string(),
  })
  .strict();

const GcResultSchema = z
  .object({
    removedSessions: z.array(NonEmptyStringSchema),
    skippedSessions: z.array(GcSkippedSessionSchema),
    dryRun: z.boolean(),
    totalBytesFreed: z.number().nonnegative(),
  })
  .strict();

interface GoldenResultContractCase {
  name: string;
  command: string;
  schema: z.ZodType;
  validResult: unknown;
  invalidResult: unknown;
  extraFieldResult: unknown;
}

function createSessionRecord() {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'exited' as const,
    command: ['/bin/sh', '-lc', 'echo hello'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: null,
    childPid: null,
    exitCode: 0,
    exitSignal: null,
  };
}

function expectLockedSuccessEnvelope(command: string, result: unknown): void {
  expect(createSuccessEnvelope(command, result)).toEqual({
    ok: true,
    command,
    timestamp: LOCKED_TIMESTAMP,
    result,
  });
}

const goldenResultContracts: readonly GoldenResultContractCase[] = [
  {
    name: 'create',
    command: 'create',
    schema: CreateResultSchema,
    validResult: {
      sessionId: 'session-01',
      createdAt: '2026-03-19T12:00:00.000Z',
      cols: 80,
      rows: 24,
      shell: '/bin/bash',
      env: {
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
      },
      idleTimeoutMs: 600000,
    },
    invalidResult: {},
    extraFieldResult: {
      sessionId: 'session-01',
      createdAt: '2026-03-19T12:00:00.000Z',
      cols: 80,
      rows: 24,
      shell: '/bin/bash',
      started: true,
    },
  },
  {
    name: 'list',
    command: 'list',
    schema: ListResultSchema,
    validResult: {
      sessions: [
        {
          sessionId: 'session-01',
          status: 'running',
          command: ['/bin/sh', '-lc', 'echo hello'],
          createdAt: '2026-03-19T12:00:00.000Z',
          name: 'hello-session',
          pid: 1234,
        },
        {
          sessionId: 'session-02',
          status: 'exited',
          command: ['/bin/sh', '-lc', 'exit 0'],
          createdAt: '2026-03-19T12:05:00.000Z',
          pid: null,
        },
      ],
    },
    invalidResult: {
      sessions: [{}],
    },
    extraFieldResult: {
      sessions: [
        {
          sessionId: 'session-01',
          status: 'running',
          command: ['/bin/sh', '-lc', 'echo hello'],
          createdAt: '2026-03-19T12:00:00.000Z',
          pid: 1234,
          term: 'xterm-256color',
        },
      ],
    },
  },
  {
    name: 'doctor',
    command: 'doctor',
    schema: DoctorResultSchema,
    validResult: {
      ok: true,
      checks: {
        environment: [
          {
            name: 'node-runtime',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'cwd-access',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'temp-dir',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'home_isolation',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'home-writable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'pty-spawn',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'socket-viable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'artifact-atomicity',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'event-log-writable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
        ],
        renderer: [
          {
            name: 'playwright_available',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'browser_cache_accessible',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'browser_launch',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'ghostty_web_available',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'screenshot_viable',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
        ],
      },
      capabilities: [
        {
          name: 'snapshot',
          status: 'available',
        },
      ],
    },
    invalidResult: {
      ok: true,
      checks: {
        environment: [
          {
            name: 'node-runtime',
            status: 'pass',
            message: 'ok',
            durationMs: -1,
          },
          {
            name: 'cwd-access',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'temp-dir',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'home_isolation',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'home-writable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'pty-spawn',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'socket-viable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'artifact-atomicity',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'event-log-writable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
        ],
        renderer: [
          {
            name: 'playwright_available',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'browser_cache_accessible',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'browser_launch',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'ghostty_web_available',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'screenshot_viable',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
        ],
      },
      capabilities: [],
    },
    extraFieldResult: {
      ok: true,
      checks: {
        environment: [
          {
            name: 'node-runtime',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
            ok: true,
          },
          {
            name: 'cwd-access',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'temp-dir',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'home_isolation',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'home-writable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'pty-spawn',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'socket-viable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'artifact-atomicity',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
          {
            name: 'event-log-writable',
            status: 'pass',
            message: 'ok',
            durationMs: 1,
          },
        ],
        renderer: [
          {
            name: 'playwright_available',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'browser_cache_accessible',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'browser_launch',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'ghostty_web_available',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
          {
            name: 'screenshot_viable',
            status: 'pass',
            message: 'ok',
            durationMs: 2,
          },
        ],
      },
      capabilities: [],
    },
  },
  {
    name: 'gc',
    command: 'gc',
    schema: GcResultSchema,
    validResult: {
      removedSessions: ['01J0000000TEST000000000000'],
      skippedSessions: [
        {
          sessionId: '01J0000000SKIP000000000000',
          reason: 'running',
        },
      ],
      dryRun: false,
      totalBytesFreed: 4096,
    },
    invalidResult: {
      removedSessions: ['01J0000000TEST000000000000'],
      skippedSessions: [],
      dryRun: false,
      totalBytesFreed: -1,
    },
    extraFieldResult: {
      removedSessions: ['01J0000000TEST000000000000'],
      skippedSessions: [],
      dryRun: false,
      totalBytesFreed: 4096,
      removedCount: 1,
    },
  },
  {
    name: 'gc (dry-run)',
    command: 'gc',
    schema: GcResultSchema,
    validResult: {
      removedSessions: [],
      skippedSessions: [],
      dryRun: true,
      totalBytesFreed: 0,
    },
    invalidResult: {
      removedSessions: [],
      skippedSessions: [
        {
          sessionId: '01J0000000SKIP000000000000',
        },
      ],
      dryRun: true,
      totalBytesFreed: 0,
    },
    extraFieldResult: {
      removedSessions: [],
      skippedSessions: [],
      dryRun: true,
      totalBytesFreed: 0,
      wouldRemoveSessions: [],
    },
  },
  {
    name: 'run',
    command: 'run',
    schema: RunResultSchema,
    validResult: {
      accepted: true,
      completed: true,
      timedOut: false,
      seq: 42,
      durationMs: 1500,
      marker: '__AT_MARKER_abc123__',
    },
    invalidResult: {
      accepted: false,
      seq: -1,
    },
    extraFieldResult: {
      accepted: true,
      completed: true,
      timedOut: false,
      seq: 42,
      durationMs: 1500,
      marker: '__AT_MARKER_abc123__',
      exitCode: 0,
    },
  },
  {
    name: 'send-keys',
    command: 'send-keys',
    schema: SendKeysResultSchema,
    validResult: {
      accepted: ['Enter', 'Ctrl+C'],
      bytesWritten: 2,
      seq: 7,
    },
    invalidResult: {
      accepted: [],
      bytesWritten: -1,
      seq: -1,
    },
    extraFieldResult: {
      accepted: ['Enter'],
      bytesWritten: 1,
      seq: 7,
      keyCount: 1,
    },
  },
  {
    name: 'snapshot',
    command: 'snapshot',
    schema: SnapshotResultSchema,
    validResult: {
      format: 'structured',
      sessionId: 'session-01',
      capturedAtSeq: 7,
      cols: 80,
      rows: 24,
      cursorRow: 1,
      cursorCol: 5,
      isAltScreen: false,
      visibleLines: [
        {
          row: 0,
          text: '$ echo hello',
        },
        {
          row: 1,
          text: 'hello',
        },
      ],
      scrollbackLines: [
        {
          row: 0,
          text: 'prior output',
        },
      ],
      cells: [
        {
          lineNumber: 0,
          cells: [
            {
              char: '$',
              fg: '#ffffff',
              bold: true,
            },
            {
              char: ' ',
            },
          ],
        },
      ],
    },
    invalidResult: {},
    extraFieldResult: {
      format: 'structured',
      sessionId: 'session-01',
      capturedAtSeq: 7,
      cols: 80,
      rows: 24,
      cursorRow: 1,
      cursorCol: 5,
      isAltScreen: false,
      visibleLines: [
        {
          row: 0,
          text: '$ echo hello',
        },
      ],
      renderTimeMs: 12,
    },
  },
  {
    name: 'screenshot',
    command: 'screenshot',
    schema: ScreenshotResultSchema,
    validResult: {
      sessionId: 'session-01',
      capturedAtSeq: 8,
      profileName: 'reference-dark',
      cols: 80,
      rows: 24,
      artifactPath:
        '/tmp/agent-terminal/sessions/session-01/artifacts/screenshot-8-reference-dark.png',
      pngSizeBytes: 4096,
      cursorVisible: true,
      rendererBackend: 'ghostty-web',
      pixelWidth: 640,
      pixelHeight: 384,
      sha256: 'a'.repeat(64),
      renderProfileHash: 'b'.repeat(64),
    },
    invalidResult: {
      sessionId: 'session-01',
      capturedAtSeq: 8,
      profileName: 'reference-dark',
      cols: 80,
      rows: 24,
      artifactPath: '/tmp/screenshot.png',
      pngSizeBytes: 0,
    },
    extraFieldResult: {
      sessionId: 'session-01',
      capturedAtSeq: 8,
      profileName: 'reference-dark',
      cols: 80,
      rows: 24,
      artifactPath: '/tmp/screenshot.png',
      pngSizeBytes: 4096,
      dpi: 96,
    },
  },
  {
    name: 'record export (asciicast)',
    command: 'record export',
    schema: RecordExportResultSchema,
    validResult: {
      sessionId: '01J0000000TEST000000000000',
      format: 'asciicast',
      artifactPath: '/tmp/test.cast',
      bytes: 1024,
      sha256: 'abc123',
      capturedAtSeq: 42,
      durationMs: 5000,
      metadata: {
        width: 80,
        height: 24,
      },
    },
    invalidResult: {
      sessionId: '01J0000000TEST000000000000',
      format: 'asciicast',
      artifactPath: '/tmp/test.cast',
      bytes: 0,
      sha256: 'abc123',
      capturedAtSeq: 42,
      metadata: {},
    },
    extraFieldResult: {
      sessionId: '01J0000000TEST000000000000',
      format: 'asciicast',
      artifactPath: '/tmp/test.cast',
      bytes: 1024,
      sha256: 'abc123',
      capturedAtSeq: 42,
      metadata: {},
      exportedBy: 'cli',
    },
  },
  {
    name: 'record export (webm)',
    command: 'record export',
    schema: RecordExportResultSchema,
    validResult: {
      sessionId: '01J0000000TEST000000000000',
      format: 'webm',
      artifactPath: '/tmp/test.webm',
      bytes: 2048,
      sha256: 'def456',
      capturedAtSeq: 42,
      metadata: {
        width: 80,
        height: 24,
        profileName: 'default',
      },
    },
    invalidResult: {
      sessionId: '01J0000000TEST000000000000',
      format: 'webm',
      artifactPath: '/tmp/test.webm',
      bytes: 2048,
      sha256: 'def456',
      capturedAtSeq: -1,
      metadata: {},
    },
    extraFieldResult: {
      sessionId: '01J0000000TEST000000000000',
      format: 'webm',
      artifactPath: '/tmp/test.webm',
      bytes: 2048,
      sha256: 'def456',
      capturedAtSeq: 42,
      metadata: {},
      profile: 'default',
    },
  },
  {
    name: 'destroy',
    command: 'destroy',
    schema: DestroyResultSchema,
    validResult: {
      sessionId: 'session-01',
      destroyed: true,
    },
    invalidResult: {},
    extraFieldResult: {
      sessionId: 'session-01',
      destroyed: true,
      status: 'destroyed',
    },
  },
  {
    name: 'wait (legacy)',
    command: 'wait',
    schema: WaitResultSchema,
    validResult: {
      exitCode: 0,
      timedOut: false,
    },
    invalidResult: {
      exitCode: 2.5,
      timedOut: false,
    },
    extraFieldResult: {
      exitCode: 0,
      timedOut: false,
      idleMs: 100,
    },
  },
  {
    name: 'wait (render)',
    command: 'wait',
    schema: WaitForRenderResultSchema,
    validResult: {
      matched: true,
      timedOut: false,
      matchedText: 'READY',
      cursorRow: 4,
      cursorCol: 0,
      capturedAtSeq: 9,
    },
    invalidResult: {
      matched: true,
      timedOut: false,
    },
    extraFieldResult: {
      matched: true,
      timedOut: false,
      capturedAtSeq: 9,
      matchCount: 1,
    },
  },
];

describe('JSON envelope contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(LOCKED_TIMESTAMP));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks the inspect success envelope shape with live renderer runtime', () => {
    const result = InspectResultSchema.parse({
      session: createSessionRecord(),
      eventCount: 2,
      uptime: 1_000,
      lastEventSeq: 1,
      terminationCategory: 'clean-exit',
      artifacts: {
        total: 2,
        byKind: {
          screenshot: 1,
          snapshot: 1,
        },
        missingCount: 0,
        health: 'healthy',
      },
      usedOfflineReplay: false,
      rendererRuntime: {
        backend: 'ghostty-web',
        mode: 'live-host',
        status: 'healthy',
      },
    });

    expectLockedSuccessEnvelope('inspect', result);
    expect(InspectResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts inspect result with offline renderer runtime', () => {
    const result = {
      session: createSessionRecord(),
      eventCount: 2,
      uptime: 1_000,
      lastEventSeq: 1,
      terminationCategory: 'clean-exit',
      artifacts: {
        total: 2,
        byKind: {
          screenshot: 1,
          snapshot: 1,
        },
        missingCount: 0,
        health: 'healthy',
      },
      usedOfflineReplay: true,
      rendererRuntime: {
        backend: 'ghostty-web',
        mode: 'offline-replay',
        status: 'fallback',
        reason: 'host-unreachable',
      },
    };

    expect(InspectResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts inspect result with unavailable renderer runtime', () => {
    const result = {
      session: createSessionRecord(),
      eventCount: 2,
      uptime: 1_000,
      lastEventSeq: 1,
      terminationCategory: 'clean-exit',
      artifacts: {
        total: 2,
        byKind: {
          screenshot: 1,
          snapshot: 1,
        },
        missingCount: 0,
        health: 'healthy',
      },
      usedOfflineReplay: false,
      rendererRuntime: {
        backend: 'ghostty-web',
        mode: 'live-host',
        status: 'unavailable',
        reason: 'renderer-not-installed',
      },
    };

    expect(InspectResultSchema.safeParse(result).success).toBe(true);
  });

  it('locks the skill success envelope shape', async () => {
    const result = await buildSkillResult();

    expectLockedSuccessEnvelope('skill', result);
    expect(SkillResultSchema.safeParse(result).success).toBe(true);
  });

  it('locks the version success envelope shape', async () => {
    const result = await buildVersionResult();

    expectLockedSuccessEnvelope('version', result);
    expect(VersionResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts version result with capabilities', async () => {
    const result = {
      ...(await buildVersionResult()),
      capabilities: [
        {
          name: 'snapshot',
          status: 'available',
        },
        {
          name: 'screenshot',
          status: 'unavailable',
          reason: 'playwright not installed',
        },
      ],
    };

    expect(VersionResultSchema.safeParse(result).success).toBe(true);
  });

  describe.each(goldenResultContracts)('$name result contract', (contract) => {
    it('accepts a valid result in the success envelope', () => {
      const result = contract.schema.parse(contract.validResult);

      expectLockedSuccessEnvelope(contract.command, result);
      expect(contract.schema.safeParse(result).success).toBe(true);
    });

    it('rejects an invalid result', () => {
      expect(contract.schema.safeParse(contract.invalidResult).success).toBe(
        false,
      );
    });

    it('rejects extra fields to enforce strict mode', () => {
      expect(contract.schema.safeParse(contract.extraFieldResult).success).toBe(
        false,
      );
    });
  });

  it('locks the SESSION_NOT_FOUND error envelope shape', () => {
    const error = makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: 'Session "missing-session" was not found.',
      details: {
        sessionId: 'missing-session',
        manifestPath:
          '/tmp/agent-terminal/sessions/missing-session/session.json',
      },
    });

    expect(
      createErrorEnvelope('inspect', {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      }),
    ).toEqual({
      ok: false,
      command: 'inspect',
      timestamp: LOCKED_TIMESTAMP,
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session "missing-session" was not found.',
        retryable: false,
        details: {
          sessionId: 'missing-session',
          manifestPath:
            '/tmp/agent-terminal/sessions/missing-session/session.json',
        },
      },
    });
  });

  it('locks a retryable transport-style error envelope shape', () => {
    const error = makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
      details: {
        sessionId: 'session-01',
      },
    });

    expect(
      createErrorEnvelope('inspect', {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      }),
    ).toEqual({
      ok: false,
      command: 'inspect',
      timestamp: LOCKED_TIMESTAMP,
      error: {
        code: 'HOST_UNREACHABLE',
        message: 'Session host is unreachable.',
        retryable: true,
        details: {
          sessionId: 'session-01',
        },
      },
    });
  });
});
