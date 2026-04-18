import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import exploratoryQaCase from '../../../evals/dogfood/cases/exploratory-qa.js';
import { doctorGatedCase } from '../../../evals/execution/cases/doctor-gated.js';
import { helloPromptCase } from '../../../evals/execution/cases/hello-prompt.js';
import {
  JsonReportSchema,
  NormalizedProviderOutputSchema,
  ProviderAgentRequestSchema,
  ProviderAgentResultSchema,
  ProviderPromptRequestSchema,
  ProviderPromptResultSchema,
  ProviderRuntimeInfoSchema,
} from '../../../evals/lib/schemas.js';
import { TRIGGER_AGENT_TTY_PROMPT_CASES } from '../../../evals/prompt/cases/trigger-agent-tty.js';
import type {
  DogfoodEvalCase,
  ExecutionEvalCase,
  PromptEvalCase,
  ProviderAgentResult,
  ProviderPromptResult,
  ProviderRuntimeInfo,
} from '../../../evals/lib/types.js';

const DEFAULT_EVAL_TIMEOUT_MS = 45_000;
const FIXTURE_STARTED_AT = '2026-01-01T00:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-01-01T00:00:00.001Z';
const PLACEHOLDER_HOME_DIR = '/tmp/agent-tty-evals-home';
const PLACEHOLDER_OUTPUT_DIR = '/tmp/agent-tty-evals-output';
const PLACEHOLDER_RUN_ID = 'fixture-run';
const PLACEHOLDER_PROVIDER_ID = 'fixture';
const PLACEHOLDER_MODEL_ID = 'fixture-model';

const LaneSchema = z.enum(['prompt', 'execution', 'dogfood']);
const ConditionSchema = z.enum(['none', 'self-load', 'preloaded', 'stale']);
const ExpectedSkillSchema = z.enum(['none', 'agent-tty', 'dogfood-tui']);
const LaneErrorSchema = z
  .object({
    lane: LaneSchema,
    message: z.string().min(1),
  })
  .strict();
const SelectedCaseSchema = z
  .object({
    lane: LaneSchema,
    caseId: z.string().min(1),
    category: z.string().min(1),
    expectedSkill: ExpectedSkillSchema,
    conditions: z.array(ConditionSchema).min(1),
    fixture: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
  })
  .strict();
const EvalRunSummarySchema = z
  .object({
    ok: z.boolean(),
    runId: z.string().min(1).optional(),
    providerId: z.string().min(1),
    modelId: z.string().min(1).optional(),
    lanes: z.array(LaneSchema).min(1),
    conditions: z.array(ConditionSchema).min(1),
    totalInvocations: z.number().int().nonnegative(),
    totalResults: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    outputBaseDir: z.string().min(1),
    runDir: z.string().min(1).optional(),
    jsonReportPath: z.string().min(1).optional(),
    markdownReportPath: z.string().min(1).optional(),
    laneErrors: z.array(LaneErrorSchema),
    dryRun: z.boolean(),
    selectedCases: z.array(SelectedCaseSchema).min(1),
  })
  .strict();

const JsonReportEnvelopeSchema = z
  .object({
    metadata: JsonReportSchema.shape.metadata,
    results: JsonReportSchema.shape.results,
  })
  .loose();

type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>;

type PilotCaseExpectation = {
  lane: z.infer<typeof LaneSchema>;
  caseId: string;
  expectedSkill: z.infer<typeof ExpectedSkillSchema>;
  expectedOk: boolean;
  fixture?: string;
};

const FIXTURE_RUNTIME_INFO = ProviderRuntimeInfoSchema.parse({
  providerId: PLACEHOLDER_PROVIDER_ID,
  available: true,
  detectedAt: FIXTURE_STARTED_AT,
  version: 'fixture',
  commandPath: 'fixture',
  defaultModelId: PLACEHOLDER_MODEL_ID,
  capabilities: {
    supportsDetect: true,
    supportsPlanMode: true,
    supportsAgentMode: true,
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsTranscriptCapture: true,
  },
  notes: ['eval authoring pilot integration fixture'],
}) as ProviderRuntimeInfo;

const waitForOutputCase = findPromptCaseOrThrow('wait-for-output');
const PILOT_CASES: readonly PilotCaseExpectation[] = [
  {
    lane: 'prompt',
    caseId: 'wait-for-output',
    expectedSkill: 'agent-tty',
    expectedOk: true,
  },
  {
    lane: 'execution',
    caseId: 'hello-prompt',
    expectedSkill: 'agent-tty',
    expectedOk: true,
    fixture: 'hello-prompt',
  },
  {
    lane: 'execution',
    caseId: 'doctor-gated',
    expectedSkill: 'agent-tty',
    expectedOk: true,
    fixture: 'hello-prompt',
  },
  {
    lane: 'dogfood',
    caseId: 'exploratory-qa',
    expectedSkill: 'dogfood-tui',
    expectedOk: true,
    fixture: 'hello-prompt',
  },
] as const;

function findPromptCaseOrThrow(caseId: string): PromptEvalCase {
  const evalCase = TRIGGER_AGENT_TTY_PROMPT_CASES.find(
    (candidate) => candidate.id === caseId,
  );
  if (evalCase === undefined) {
    throw new Error(`Expected prompt case ${caseId} to be registered`);
  }
  return evalCase;
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} must be defined`);
  }
  return value;
}

function buildNormalizedOutput(text: string) {
  return NormalizedProviderOutputSchema.parse({
    finalText: text,
    messages: [text],
    referencedSkills: [],
    toolCalls: [],
  });
}

function buildPromptFixture(
  evalCase: PromptEvalCase,
  responseText: string,
): ProviderPromptResult {
  const request = ProviderPromptRequestSchema.parse({
    runId: PLACEHOLDER_RUN_ID,
    providerId: PLACEHOLDER_PROVIDER_ID,
    condition: 'none',
    trial: 1,
    modelId: PLACEHOLDER_MODEL_ID,
    cwd: process.cwd(),
    evalCase,
  });

  return ProviderPromptResultSchema.parse({
    request,
    runtime: FIXTURE_RUNTIME_INFO,
    ok: true,
    exitCode: 0,
    signal: null,
    startedAt: FIXTURE_STARTED_AT,
    completedAt: FIXTURE_COMPLETED_AT,
    durationMs: 1,
    rawStdout: responseText,
    rawStderr: '',
    normalized: buildNormalizedOutput(responseText),
  }) as ProviderPromptResult;
}

function buildAgentFixture(
  evalCase: ExecutionEvalCase | DogfoodEvalCase,
  transcript: string,
  options: {
    bundlePath?: string;
    rawStderr?: string;
  } = {},
): ProviderAgentResult {
  const request = ProviderAgentRequestSchema.parse({
    runId: PLACEHOLDER_RUN_ID,
    providerId: PLACEHOLDER_PROVIDER_ID,
    condition: 'none',
    trial: 1,
    modelId: PLACEHOLDER_MODEL_ID,
    cwd: process.cwd(),
    homeDir: PLACEHOLDER_HOME_DIR,
    outputDir: PLACEHOLDER_OUTPUT_DIR,
    evalCase,
  });

  return ProviderAgentResultSchema.parse({
    request,
    runtime: FIXTURE_RUNTIME_INFO,
    ok: true,
    exitCode: 0,
    signal: null,
    startedAt: FIXTURE_STARTED_AT,
    completedAt: FIXTURE_COMPLETED_AT,
    durationMs: 1,
    rawStdout: transcript,
    rawStderr: options.rawStderr ?? '',
    normalized: buildNormalizedOutput(transcript),
    ...(options.bundlePath === undefined
      ? {}
      : { bundlePath: options.bundlePath }),
  }) as ProviderAgentResult;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function createFixtureProviderDirectory(fixtureRoot: string): void {
  const promptResponse =
    'Use agent-tty and run `agent-tty wait --json --pattern "Listening on port 3000"` before starting the tests so you only proceed after the server is ready.';
  const helloTranscript = [
    'agent-tty create --json',
    'agent-tty type --json --text "hello world"',
    'agent-tty wait --json --pattern "READY>"',
    'ECHO: hello world',
    'READY>',
    'agent-tty snapshot --json',
    'agent-tty destroy --json',
  ].join('\n');
  const doctorTranscript = [
    'agent-tty create --json',
    'agent-tty doctor --json',
    '{"checks":[{"name":"screenshot","status":"pass"}]}',
    'agent-tty screenshot --json doctor-gated-proof.png',
  ].join('\n');
  const dogfoodNotes = [
    '# Title',
    'hello-prompt exploratory QA',
    '',
    '## Reproduction steps',
    '1. Run `npx tsx src/cli/main.ts create --json` for the hello-prompt fixture.',
    '2. Use `npx tsx src/cli/main.ts snapshot --json` after each scripted input.',
    '',
    'Expected: the fixture should echo input and exit cleanly.',
    'Actual: consistent clean shutdown across the scripted inputs.',
    '',
    '## Findings',
    '- Severity: low',
    '- Focus / input: blank input was accepted without crashing.',
    '',
    '## Evidence',
    '- screenshot: proof.png',
    '- recording: proof.cast',
    '- notes: notes.md',
    '- manifest: manifest.json',
  ].join('\n');

  const doctorBundleDir = join(fixtureRoot, 'artifacts', 'doctor-gated');
  const dogfoodBundleDir = join(fixtureRoot, 'bundles', 'exploratory-qa');
  mkdirSync(doctorBundleDir, { recursive: true });
  mkdirSync(dogfoodBundleDir, { recursive: true });
  writeText(join(doctorBundleDir, 'doctor-gated-proof.png'), 'png fixture');
  writeText(join(dogfoodBundleDir, 'proof.png'), 'png fixture');
  writeText(join(dogfoodBundleDir, 'proof.cast'), 'cast fixture');
  writeText(join(dogfoodBundleDir, 'notes.md'), dogfoodNotes);
  writeJson(join(dogfoodBundleDir, 'manifest.json'), {
    generatedBy: 'authoring-pilots.test.ts',
    artifacts: ['proof.png', 'proof.cast', 'notes.md', 'manifest.json'],
  });
  writeText(
    join(dogfoodBundleDir, 'index.html'),
    '<html><body>fixture</body></html>',
  );

  writeJson(join(fixtureRoot, 'runtime-info.json'), FIXTURE_RUNTIME_INFO);
  writeJson(
    join(fixtureRoot, 'responses', 'wait-for-output.json'),
    buildPromptFixture(waitForOutputCase, promptResponse),
  );
  writeJson(
    join(fixtureRoot, 'agent-results', 'hello-prompt.json'),
    buildAgentFixture(helloPromptCase, helloTranscript),
  );
  writeJson(
    join(fixtureRoot, 'agent-results', 'doctor-gated.json'),
    buildAgentFixture(doctorGatedCase, doctorTranscript, {
      bundlePath: doctorBundleDir,
    }),
  );
  writeJson(
    join(fixtureRoot, 'agent-results', 'exploratory-qa.json'),
    buildAgentFixture(exploratoryQaCase, dogfoodNotes, {
      bundlePath: dogfoodBundleDir,
    }),
  );
}

function runEvalCli(
  argumentsList: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './evals/run.ts', ...argumentsList],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: DEFAULT_EVAL_TIMEOUT_MS,
      env: {
        ...process.env,
        ...extraEnv,
      },
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  expect(result.stderr).toBe('');
  return result;
}

function parseSummary(stdout: string): EvalRunSummary {
  return EvalRunSummarySchema.parse(JSON.parse(stdout));
}

function expectSelectedCase(
  summary: EvalRunSummary,
  pilot: PilotCaseExpectation,
): void {
  expect(summary.selectedCases).toHaveLength(1);
  expect(summary.selectedCases[0]).toMatchObject({
    lane: pilot.lane,
    caseId: pilot.caseId,
    expectedSkill: pilot.expectedSkill,
    conditions: ['none'],
    ...(pilot.fixture === undefined ? {} : { fixture: pilot.fixture }),
  });
}

function readReport(summary: EvalRunSummary) {
  if (summary.jsonReportPath === undefined) {
    throw new Error('Expected jsonReportPath in non-dry-run eval summary');
  }
  const text = readFileSync(summary.jsonReportPath, 'utf8');
  return JsonReportEnvelopeSchema.parse(JSON.parse(text));
}

let testRoot = '';
let fixtureRoot = '';

describe(
  'eval CLI authoring pilot cases',
  { timeout: DEFAULT_EVAL_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      // prettier-ignore
      testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-evals-authoring-pilots-')));
      fixtureRoot = join(testRoot, 'fixture-provider');
      createFixtureProviderDirectory(fixtureRoot);
    });

    afterEach(() => {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
      fixtureRoot = '';
    });

    for (const pilot of PILOT_CASES) {
      it(`resolves ${pilot.caseId} in the dry-run matrix`, () => {
        const result = runEvalCli([
          '--provider',
          'stub',
          '--lane',
          pilot.lane,
          '--case',
          pilot.caseId,
          '--condition',
          'none',
          '--dry-run',
          '--json',
        ]);

        expect(result.status).toBe(0);
        const summary = parseSummary(result.stdout);
        expect(summary).toMatchObject({
          ok: true,
          providerId: 'stub',
          lanes: [pilot.lane],
          conditions: ['none'],
          totalInvocations: 1,
          totalResults: 0,
          passed: 0,
          failed: 0,
          dryRun: true,
          laneErrors: [],
        });
        expectSelectedCase(summary, pilot);
      });

      it(`runs ${pilot.caseId} end-to-end through the CLI facade with fixture playback`, () => {
        const outputDir = join(testRoot, `run-${pilot.caseId}`);
        const result = runEvalCli(
          [
            '--provider',
            'fixture',
            '--lane',
            pilot.lane,
            '--case',
            pilot.caseId,
            '--condition',
            'none',
            '--output',
            outputDir,
            '--json',
          ],
          {
            EVAL_FIXTURE_DIR: fixtureRoot,
          },
        );

        const summary = parseSummary(result.stdout);
        expect(result.status).toBe(summary.ok ? 0 : 1);
        expect(summary).toMatchObject({
          ok: pilot.expectedOk,
          providerId: 'fixture',
          lanes: [pilot.lane],
          conditions: ['none'],
          totalInvocations: 1,
          totalResults: 1,
          passed: pilot.expectedOk ? 1 : 0,
          failed: pilot.expectedOk ? 0 : 1,
          dryRun: false,
          laneErrors: [],
        });
        expectSelectedCase(summary, pilot);

        const report = readReport(summary);
        expect(report.metadata.providers).toEqual(['fixture']);
        expect(report.metadata.lanes).toEqual([pilot.lane]);
        expect(report.metadata.conditions).toEqual(['none']);
        expect(report.results).toHaveLength(1);

        const singleResult = requireDefined(
          report.results[0],
          'report.results[0]',
        );
        expect(singleResult).toMatchObject({
          lane: pilot.lane,
          caseId: pilot.caseId,
          condition: 'none',
          expectedSkill: pilot.expectedSkill,
          ok: pilot.expectedOk,
        });
        expect(singleResult.errorClass).toBeUndefined();
        expect(singleResult.errorMessage).toBeUndefined();
      });
    }
  },
);
