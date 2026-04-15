import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  readEvalEvents: vi.fn(),
  validateBundle: vi.fn(),
  sessionDir: vi.fn(),
  manifestPath: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('../../../evals/lib/cliHarness.js', () => ({
  readEvalEvents: mocks.readEvalEvents,
}));

vi.mock('../../../src/tools/validate-bundle.js', () => ({
  validateBundle: mocks.validateBundle,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  manifestPath: mocks.manifestPath,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: mocks.readFile,
    stat: mocks.stat,
  };
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { EventRecord } from '../../../src/protocol/schemas.js';
import type {
  BundleValidationCheck,
  BundleValidationResult,
} from '../../../src/tools/validate-bundle.js';
import {
  verify,
  verifyArtifactExists,
  verifyBundleValid,
  verifyEventLogCheck,
  verifyExitCode,
  verifySnapshotContains,
} from '../../../evals/execution/verifiers/index.js';
import type {
  VerifierContext,
  VerifierResult,
} from '../../../evals/execution/verifiers/index.js';
import type { VerifierSpec } from '../../../evals/lib/types.js';

let actualFsPromises: typeof FsPromises;
const tempDirs = new Set<string>();

beforeAll(async () => {
  actualFsPromises =
    await vi.importActual<typeof FsPromises>('node:fs/promises');
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readEvalEvents.mockReturnValue([]);
  mocks.validateBundle.mockResolvedValue(createBundleValidationResult());
  mocks.sessionDir.mockImplementation((home: string, sessionId: string) =>
    join(home, 'sessions', sessionId),
  );
  mocks.manifestPath.mockImplementation((sessionDirectory: string) =>
    join(sessionDirectory, 'manifest.json'),
  );
  mocks.readFile.mockRejectedValue(createFsMissingError());
  mocks.stat.mockRejectedValue(createFsMissingError());
});

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.clear();
});

function createContext(
  overrides: Partial<VerifierContext> = {},
): VerifierContext {
  return {
    home: '/tmp/evals-home',
    sessionId: 'session-01',
    transcript: 'hello world\nrender complete',
    artifacts: [],
    ...overrides,
  };
}

function createSpec(
  kind: VerifierSpec['kind'],
  config: Record<string, unknown>,
  overrides: Partial<Omit<VerifierSpec, 'kind' | 'config'>> = {},
): VerifierSpec {
  return {
    id: overrides.id ?? `${kind}-01`,
    kind,
    description: overrides.description ?? `${kind} verifier`,
    required: overrides.required ?? true,
    config,
  };
}

function createOutputEvent(seq: number, data: string): EventRecord {
  return {
    seq,
    ts: createTimestamp(seq),
    type: 'output',
    payload: { data },
  };
}

function createExitEvent(seq: number, exitCode: number | null): EventRecord {
  return {
    seq,
    ts: createTimestamp(seq),
    type: 'exit',
    payload: {
      exitCode,
      exitSignal: null,
    },
  };
}

function createSignalEvent(seq: number, signal = 'SIGTERM'): EventRecord {
  return {
    seq,
    ts: createTimestamp(seq),
    type: 'signal',
    payload: { signal },
  };
}

function createTimestamp(seq: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
}

function createFsMissingError(): NodeJS.ErrnoException {
  const error = new Error('ENOENT');
  error.name = 'ENOENT';
  return Object.assign(error, { code: 'ENOENT' });
}

function createBundleCheck(
  name: string,
  ok: boolean,
  message: string,
): BundleValidationCheck {
  return { name, ok, message };
}

function createBundleValidationResult(
  overrides: Partial<BundleValidationResult> = {},
): BundleValidationResult {
  return {
    bundleDir: '/tmp/bundle',
    profile: 'interactive-renderer',
    ok: true,
    checks: [createBundleCheck('bundle-exists', true, 'Bundle exists.')],
    ...overrides,
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-tty-verifiers-'));
  tempDirs.add(dir);
  return dir;
}

async function createArtifactFiles(fileNames: string[]): Promise<string[]> {
  const dir = await createTempDir();
  const paths: string[] = [];

  for (const fileName of fileNames) {
    const artifactPath = join(dir, fileName);
    const content = fileName.endsWith('.json') ? '{}' : `artifact:${fileName}`;
    await writeFile(artifactPath, content, 'utf8');
    paths.push(artifactPath);
  }

  return paths;
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} must be defined`);
  }
  return value;
}

function useRealStat(): void {
  mocks.stat.mockImplementation(
    actualFsPromises.stat as Parameters<
      typeof mocks.stat.mockImplementation
    >[0],
  );
}

function useRealReadFile(): void {
  mocks.readFile.mockImplementation(
    actualFsPromises.readFile as Parameters<
      typeof mocks.readFile.mockImplementation
    >[0],
  );
}

function expectFailure(
  result: VerifierResult,
): VerifierResult & { pass: false } {
  expect(result.pass).toBe(false);
  return result as VerifierResult & { pass: false };
}

describe('verify dispatch', () => {
  it('dispatches snapshot specs to transcript pattern verification', async () => {
    const result = await verify(
      createSpec('snapshot', {
        patterns: ['hello', 'render complete'],
      }),
      createContext(),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Matched all 2 required snapshot pattern(s).',
    });
  });

  it('returns missingPatterns details for snapshot dispatch misses', async () => {
    const result = await verify(
      createSpec('snapshot', {
        patterns: ['hello', 'goodbye'],
      }),
      createContext({ transcript: 'hello only' }),
    );

    expectFailure(result);
    expect(result.details).toMatchObject({
      missingPatterns: ['goodbye'],
    });
  });

  it('dispatches screenshot specs to artifact verification', async () => {
    useRealStat();
    const screenshotPath = requireDefined(
      (await createArtifactFiles(['capture.png']))[0],
      'screenshotPath',
    );

    const result = await verify(
      createSpec('screenshot', {}),
      createContext({ artifacts: [screenshotPath] }),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Found required artifacts for screenshot.',
    });
  });

  it('fails command dispatch when the verifier context is missing a sessionId', async () => {
    const result = await verify(
      createSpec('command', { expectedExitCode: 0 }),
      createContext({ sessionId: '   ' }),
    );

    expect(result).toMatchObject({
      pass: false,
      message:
        'Exit-code verification requires a sessionId in the verifier context.',
    });
  });

  it('dispatches json specs with patterns to snapshot verification', async () => {
    const result = await verify(
      createSpec('json', { patterns: ['hello world'] }),
      createContext({
        transcript: 'hello world from transcript',
        artifacts: [],
      }),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Matched all 1 required snapshot pattern(s).',
    });
  });

  it('dispatches json specs without patterns to artifact verification', async () => {
    useRealStat();
    const jsonPath = requireDefined(
      (await createArtifactFiles(['result.json']))[0],
      'jsonPath',
    );

    const result = await verify(
      createSpec('json', {}),
      createContext({ artifacts: [jsonPath], transcript: 'not used' }),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Found required artifacts for json.',
      details: {
        matchedByKind: {
          json: [jsonPath],
        },
      },
    });
  });

  it('dispatches bundle specs to bundle validation', async () => {
    const checks = [createBundleCheck('has-json-output', true, 'Found JSON.')];
    mocks.validateBundle.mockResolvedValue(
      createBundleValidationResult({ checks }),
    );

    const result = await verify(
      createSpec('bundle', { bundlePath: './proofs/case-01' }),
      createContext(),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Bundle validation passed.',
      details: {
        profile: 'interactive-renderer',
        checks,
      },
    });
    expect(mocks.validateBundle).toHaveBeenCalledWith(
      resolve('./proofs/case-01'),
      'interactive-renderer',
    );
  });

  it('dispatches custom validators using the configured validator name', async () => {
    useRealStat();
    const screenshotPath = requireDefined(
      (await createArtifactFiles(['custom.png']))[0],
      'screenshotPath',
    );

    const result = await verify(
      createSpec('custom', {
        validator: 'artifact-exists',
        kind: 'screenshot',
      }),
      createContext({ artifacts: [screenshotPath] }),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Found required artifacts for screenshot.',
    });
  });

  it('fails unsupported custom validators with a descriptive message', async () => {
    const result = await verify(
      createSpec(
        'custom',
        { validator: 'does-not-exist' },
        { id: 'custom-unsupported' },
      ),
      createContext(),
    );

    expect(result.pass).toBe(false);
    expect(result.message).toContain('Unsupported custom verifier');
    expect(result.message).toContain('custom-unsupported');
  });
});

describe('verifySnapshotContains', () => {
  it('passes when all required patterns are present', async () => {
    const result = await verifySnapshotContains(
      { patterns: ['hello', 'render complete'] },
      createContext(),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Matched all 2 required snapshot pattern(s).',
    });
  });

  it('fails with missingPatterns when required text is absent', async () => {
    const result = await verifySnapshotContains(
      { patterns: ['hello', 'missing line'] },
      createContext({ transcript: 'hello world' }),
    );

    expectFailure(result);
    expect(result.details).toMatchObject({
      missingPatterns: ['missing line'],
    });
  });

  it('fails when one pattern is not a valid regex', async () => {
    const result = await verifySnapshotContains(
      { patterns: ['hello', '['] },
      createContext(),
    );

    expect(result.pass).toBe(false);
    expect(result.message).toContain(
      'Snapshot verification failed: Invalid regex pattern',
    );
  });
});

describe('verifyArtifactExists', () => {
  it('passes when real files exist for the requested artifact kind', async () => {
    useRealStat();
    const screenshotPath = requireDefined(
      (await createArtifactFiles(['capture.png']))[0],
      'screenshotPath',
    );

    const result = await verifyArtifactExists(
      { kind: 'screenshot' },
      createContext({ artifacts: [screenshotPath] }),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Found required artifacts for screenshot.',
      details: {
        matchedByKind: {
          screenshot: [screenshotPath],
        },
      },
    });
  });

  it('fails when no artifact files exist on disk', async () => {
    useRealStat();
    const dir = await createTempDir();
    const missingPath = join(dir, 'missing.png');

    const result = await verifyArtifactExists(
      { kind: 'screenshot' },
      createContext({ artifacts: [missingPath] }),
    );

    expect(result).toMatchObject({
      pass: false,
      message: 'No artifact files were available to validate.',
    });
  });

  it('fails when only files of the wrong kind are present', async () => {
    useRealStat();
    const videoPath = requireDefined(
      (await createArtifactFiles(['capture.webm']))[0],
      'videoPath',
    );

    const result = await verifyArtifactExists(
      { kind: 'screenshot' },
      createContext({ artifacts: [videoPath] }),
    );

    expectFailure(result);
    expect(result.details).toMatchObject({
      missingKinds: ['screenshot'],
      matchedByKind: {
        screenshot: [],
      },
    });
  });

  it('filters matches by pathPatterns before counting artifacts', async () => {
    useRealStat();
    const artifactPaths = await createArtifactFiles([
      'special-report.json',
      'other-report.json',
    ]);
    const specialJson = requireDefined(artifactPaths[0], 'specialJson');
    const otherJson = requireDefined(artifactPaths[1], 'otherJson');

    const result = await verifyArtifactExists(
      {
        kind: 'json',
        pathPatterns: ['special-report\\.json$'],
      },
      createContext({ artifacts: [specialJson, otherJson] }),
    );

    expect(result).toMatchObject({
      pass: true,
      details: {
        matchedByKind: {
          json: [specialJson],
        },
      },
    });
  });
});

describe('verifyExitCode', () => {
  it('passes when the event log contains the expected exit code', async () => {
    mocks.readEvalEvents.mockReturnValue([
      createOutputEvent(0, 'hello'),
      createExitEvent(1, 0),
    ]);

    const result = await verifyExitCode(
      { expectedExitCode: 0 },
      createContext(),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Observed expected exit code 0 from the event-log.',
      details: {
        expectedExitCode: 0,
        source: 'event-log',
      },
    });
  });

  it('fails when the observed exit code does not match', async () => {
    mocks.readEvalEvents.mockReturnValue([createExitEvent(0, 1)]);

    const result = await verifyExitCode(
      { expectedExitCode: 0 },
      createContext(),
    );

    expect(result).toMatchObject({
      pass: false,
      message: 'Expected exit code 0, observed 1.',
      details: {
        expectedExitCode: 0,
        actualExitCode: 1,
        source: 'event-log',
      },
    });
  });

  it('fails when sessionId is blank', async () => {
    const result = await verifyExitCode(
      { expectedExitCode: 0 },
      createContext({ sessionId: '' }),
    );

    expect(result).toMatchObject({
      pass: false,
      message:
        'Exit-code verification requires a sessionId in the verifier context.',
    });
  });

  it('falls back to the session manifest when the event log has no exit record', async () => {
    useRealReadFile();
    const home = await createTempDir();
    const sessionId = 'session-from-manifest';
    const sessionDirectory = join(home, 'sessions', sessionId);
    const manifest = {
      version: 1,
      sessionId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      status: 'exited',
      command: ['bash'],
      cwd: home,
      cols: 80,
      rows: 24,
      hostPid: null,
      childPid: null,
      exitCode: 17,
      exitSignal: null,
    };
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      join(sessionDirectory, 'manifest.json'),
      JSON.stringify(manifest),
      'utf8',
    );

    const result = await verifyExitCode(
      { expectedExitCode: 17 },
      createContext({ home, sessionId }),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Observed expected exit code 17 from the manifest.',
      details: {
        expectedExitCode: 17,
        source: 'manifest',
      },
    });
  });
});

describe('verifyEventLogCheck', () => {
  it('passes when events satisfy the required types and output patterns', async () => {
    mocks.readEvalEvents.mockReturnValue([
      createOutputEvent(0, 'hello '),
      createOutputEvent(1, 'done'),
      createExitEvent(2, 0),
    ]);

    const result = await verifyEventLogCheck(
      {
        requiredEventTypes: ['output', 'exit'],
        forbiddenEventTypes: ['signal'],
        requiredOutputPatterns: ['hello', 'done'],
        minEvents: 2,
      },
      createContext(),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Event log satisfied 2 required type check(s).',
      details: {
        eventCount: 3,
        foundEventTypes: ['output', 'exit'],
      },
    });
  });

  it('fails when required event types are missing', async () => {
    mocks.readEvalEvents.mockReturnValue([createOutputEvent(0, 'only output')]);

    const result = await verifyEventLogCheck(
      {
        requiredEventTypes: ['output', 'exit'],
      },
      createContext(),
    );

    expectFailure(result);
    expect(result.details).toMatchObject({
      missingEventTypes: ['exit'],
      foundEventTypes: ['output'],
    });
  });

  it('fails when a forbidden event type appears in the log', async () => {
    mocks.readEvalEvents.mockReturnValue([
      createOutputEvent(0, 'hello'),
      createSignalEvent(1),
    ]);

    const result = await verifyEventLogCheck(
      {
        forbiddenEventTypes: ['signal'],
      },
      createContext(),
    );

    expectFailure(result);
    expect(result.details).toMatchObject({
      presentForbiddenEventTypes: ['signal'],
      foundEventTypes: ['output', 'signal'],
    });
  });
});

describe('verifyBundleValid', () => {
  it('passes and defaults the validation profile when validateBundle succeeds', async () => {
    const checks = [
      createBundleCheck('has-review-page', true, 'Found index.html.'),
    ];
    mocks.validateBundle.mockResolvedValue(
      createBundleValidationResult({ checks }),
    );

    const result = await verifyBundleValid(
      { bundlePath: './proofs/pass-bundle' },
      createContext(),
    );

    expect(result).toMatchObject({
      pass: true,
      message: 'Bundle validation passed.',
      details: {
        profile: 'interactive-renderer',
        checks,
      },
    });
    expect(mocks.validateBundle).toHaveBeenCalledWith(
      resolve('./proofs/pass-bundle'),
      'interactive-renderer',
    );
  });

  it('returns validator failures and preserves an explicit profile', async () => {
    const checks = [
      createBundleCheck(
        'has-json-output',
        false,
        'Expected at least one JSON output file.',
      ),
    ];
    mocks.validateBundle.mockResolvedValue(
      createBundleValidationResult({
        profile: 'contract-reporting',
        ok: false,
        checks,
      }),
    );

    const result = await verifyBundleValid(
      {
        bundlePath: '/tmp/proof-bundle',
        profile: 'contract-reporting',
      },
      createContext(),
    );

    expect(result).toMatchObject({
      pass: false,
      message: 'Bundle validation failed.',
      details: {
        profile: 'contract-reporting',
        checks,
      },
    });
    expect(mocks.validateBundle).toHaveBeenCalledWith(
      '/tmp/proof-bundle',
      'contract-reporting',
    );
  });

  it('requires bundlePath before attempting validation', async () => {
    const result = await verifyBundleValid({}, createContext());

    expect(result).toMatchObject({
      pass: false,
      message: 'Bundle verification requires config.bundlePath.',
    });
    expect(mocks.validateBundle).not.toHaveBeenCalled();
  });
});
