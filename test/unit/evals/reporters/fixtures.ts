import type {
  CaseFinishEvent,
  CaseStartEvent,
  LaneFinishEvent,
  LaneStartEvent,
  RunFinishEvent,
  RunStartEvent,
  TrialFinishEvent,
  TrialStartEvent,
} from '../../../../evals/reporters/types.js';

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const COMPLETED_AT = '2026-01-01T00:00:05.000Z';

export function createRunStartEvent(
  overrides: Partial<RunStartEvent> = {},
): RunStartEvent {
  return {
    runId: 'run-123',
    provider: 'stub',
    model: 'stub-model',
    lanes: ['prompt', 'execution'],
    conditions: ['none', 'self-load'],
    totalTrials: 2,
    totalInvocations: 8,
    outputDir: '/tmp/evals/run-123',
    startedAt: STARTED_AT,
    ...overrides,
  };
}

export function createLaneStartEvent(
  overrides: Partial<LaneStartEvent> = {},
): LaneStartEvent {
  return {
    runId: 'run-123',
    lane: 'prompt',
    caseIds: ['case-1'],
    conditions: ['none'],
    concurrency: 2,
    plannedItems: 3,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

export function createCaseStartEvent(
  overrides: Partial<CaseStartEvent> = {},
): CaseStartEvent {
  return {
    runId: 'run-123',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'none',
    plannedTrials: 2,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

export function createTrialStartEvent(
  overrides: Partial<TrialStartEvent> = {},
): TrialStartEvent {
  return {
    runId: 'run-123',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'none',
    trial: 1,
    startedAt: STARTED_AT,
    requestedOutputPath: null,
    requestedArtifactPath: null,
    ...overrides,
  };
}

export function createTrialFinishEvent(
  overrides: Partial<TrialFinishEvent> = {},
): TrialFinishEvent {
  return {
    runId: 'run-123',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'none',
    trial: 1,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    durationMs: 1234,
    status: 'passed',
    ok: true,
    errorClass: null,
    errorMessage: null,
    score: 0.5,
    transcriptPath: null,
    stdoutPath: null,
    stderrPath: null,
    eventLogPath: null,
    bundlePath: null,
    artifactManifestPath: null,
    ...overrides,
  };
}

export function createCaseFinishEvent(
  overrides: Partial<CaseFinishEvent> = {},
): CaseFinishEvent {
  return {
    runId: 'run-123',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'none',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    durationMs: 2000,
    passed: 1,
    failed: 0,
    errored: 0,
    meanScore: 0.5,
    artifactPath: null,
    reportPath: null,
    ...overrides,
  };
}

export function createLaneFinishEvent(
  overrides: Partial<LaneFinishEvent> = {},
): LaneFinishEvent {
  return {
    runId: 'run-123',
    lane: 'prompt',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    durationMs: 3000,
    total: 1,
    passed: 1,
    failed: 0,
    errored: 0,
    ...overrides,
  };
}

export function createRunFinishEvent(
  overrides: Partial<RunFinishEvent> = {},
): RunFinishEvent {
  return {
    runId: 'run-123',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    durationMs: 4000,
    total: 1,
    passed: 1,
    failed: 0,
    errored: 0,
    laneErrors: [],
    runDir: '/tmp/evals/run-123',
    reportJsonPath: '/tmp/evals/run-123/report.json',
    reportMarkdownPath: '/tmp/evals/run-123/report.md',
    ...overrides,
  };
}
