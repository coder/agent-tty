import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertString, invariant } from '../src/util/assert.js';
import { getAllDogfoodCases, runDogfoodLane } from './dogfood/runner.js';
import { getAllExecutionCases, runExecutionLane } from './execution/runner.js';
import { EvalArtifactStore, generateRunId } from './lib/artifacts.js';
import {
  buildConditionMatrix,
  computeComparisonMetrics,
  SKILL_CONDITIONS,
} from './lib/matrix.js';
import { generateJsonReport, generateMarkdownReport } from './lib/reporting.js';
import { RunMetadataSchema } from './lib/schemas.js';
import type {
  EvalCase,
  EvalLane,
  EvalResult,
  ProviderRuntimeInfo,
  RunMetadata,
  SkillCondition,
} from './lib/types.js';
import { getAllPromptCases, runPromptLane } from './prompt/runner.js';
import { createProvider, SUPPORTED_PROVIDER_IDS } from './providers/base.js';
import type { EvalProvider } from './providers/base.js';

const DEFAULT_TOTAL_TRIALS = 1;
const EVAL_LANES: readonly EvalLane[] = ['prompt', 'execution', 'dogfood'];
const EVAL_LANE_SET = new Set<string>(EVAL_LANES);
const SKILL_CONDITION_SET = new Set<string>(SKILL_CONDITIONS);
type CliProviderId = Exclude<
  (typeof SUPPORTED_PROVIDER_IDS)[number],
  'recording'
>;

const CLI_PROVIDER_IDS = SUPPORTED_PROVIDER_IDS.filter(
  (providerId) => providerId !== 'recording',
);
const CLI_PROVIDER_SET = new Set<string>(CLI_PROVIDER_IDS);

const HELP_TEXT = [
  'Usage: npx tsx evals/run.ts [options]',
  '',
  'Options:',
  `  --provider <id>     Provider to use (${CLI_PROVIDER_IDS.join(', ')})`,
  '  --model <model>     Model to use (for example: opus, claude-opus-4-6, gpt-5.4, o4-mini)',
  '  --effort <level>    Claude Code effort/thinking level (low, medium, high, max)',
  '  --lane <lane>       Lane to run (prompt, execution, dogfood, all)',
  '  --condition <cond>  Skill condition (none, self-load, preloaded, stale, all). Default: all',
  '  --case <id>         Run specific case(s) by ID. May be repeated.',
  '  --output <dir>      Output directory. Default: evals/reports/{timestamp}',
  '  --json              Print JSON summary only',
  '  --verbose           Print verbose progress logs to stderr',
  '  --dry-run           List cases that would run without invoking providers',
  '  --concurrency <n>  Maximum work items to run concurrently per lane. Default: 1',
  '  --help              Show this help text',
  '',
  'Examples:',
  '  npx tsx evals/run.ts --provider stub --lane prompt',
  '  npx tsx evals/run.ts --provider claude --model opus --effort high --lane prompt',
  '  npx tsx evals/run.ts --provider codex --model gpt-5.4 --lane all',
  '  npx tsx evals/run.ts --provider stub --lane execution --case hello-prompt --case resize-demo',
  '',
  'Notes:',
  '  - Relative --output paths resolve from the repository root.',
  '  - The fixture provider requires EVAL_FIXTURE_DIR to point at a fixture directory.',
].join('\n');

interface CliOptions {
  providerId?: string;
  modelId?: string;
  effortLevel?: string;
  lane?: string;
  condition?: string;
  caseIds: string[];
  outputDir?: string;
  concurrency?: string;
  json: boolean;
  verbose: boolean;
  dryRun: boolean;
  help: boolean;
}

interface ResolvedCliOptions {
  providerId: string;
  modelId?: string;
  effortLevel?: string;
  requestedLane: string;
  requestedCondition: string;
  caseIds: string[];
  outputBaseDir: string;
  concurrency: number;
  json: boolean;
  verbose: boolean;
  dryRun: boolean;
  activeLanes: EvalLane[];
  activeConditions: SkillCondition[];
  selectedCases: CaseSelection[];
  totalInvocations: number;
}

interface CaseSelection {
  lane: EvalLane;
  caseId: string;
  category: string;
  expectedSkill: EvalCase['expectedSkill'];
  conditions: SkillCondition[];
  fixture?: string;
  target?: string;
}

interface LaneErrorSummary {
  lane: EvalLane;
  message: string;
}

interface RunSummary {
  ok: boolean;
  runId?: string;
  providerId: string;
  modelId?: string;
  lanes: EvalLane[];
  conditions: SkillCondition[];
  totalInvocations: number;
  totalResults: number;
  passed: number;
  failed: number;
  outputBaseDir: string;
  runDir?: string;
  jsonReportPath?: string;
  markdownReportPath?: string;
  laneErrors: LaneErrorSummary[];
  dryRun: boolean;
  selectedCases: CaseSelection[];
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

function isEvalLane(value: string): value is EvalLane {
  return EVAL_LANE_SET.has(value);
}

function isSkillCondition(value: string): value is SkillCondition {
  return SKILL_CONDITION_SET.has(value);
}

function isCliProviderId(value: string): value is CliProviderId {
  return CLI_PROVIDER_SET.has(value);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareLane(left: EvalLane, right: EvalLane): number {
  return EVAL_LANES.indexOf(left) - EVAL_LANES.indexOf(right);
}

function compareCaseSelection(
  left: CaseSelection,
  right: CaseSelection,
): number {
  const laneComparison = compareLane(left.lane, right.lane);
  if (laneComparison !== 0) {
    return laneComparison;
  }
  return compareStrings(left.caseId, right.caseId);
}

function formatTimestampForPath(date: Date): string {
  const isoTimestamp = date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  return isoTimestamp.replace(/[:-]/gu, '').replace('T', '-');
}

function parseOptionValue(
  argument: string,
  optionName: string,
  argumentsList: readonly string[],
  index: number,
): { nextIndex: number; value: string } {
  assertString(argument, 'argument must be a string');
  assertString(optionName, 'optionName must be a string');
  invariant(optionName.startsWith('--'), 'optionName must start with "--"');

  if (argument === optionName) {
    const value = argumentsList[index + 1];
    invariant(value !== undefined, `${optionName} requires a value`);
    invariant(
      !value.startsWith('--'),
      `${optionName} requires a value and cannot consume another option`,
    );
    return {
      nextIndex: index + 1,
      value,
    };
  }

  invariant(
    argument.startsWith(`${optionName}=`),
    `Expected ${optionName}=<value> or ${optionName} <value>`,
  );
  const value = argument.slice(optionName.length + 1);
  invariant(value.length > 0, `${optionName} requires a non-empty value`);
  return {
    nextIndex: index,
    value,
  };
}

function parseCliArgs(argumentsList: readonly string[]): CliOptions {
  const options: CliOptions = {
    caseIds: [],
    json: false,
    verbose: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    invariant(argument !== undefined, 'CLI argument must exist');

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--json') {
      invariant(!options.json, '--json may only be provided once');
      options.json = true;
      continue;
    }
    if (argument === '--verbose') {
      invariant(!options.verbose, '--verbose may only be provided once');
      options.verbose = true;
      continue;
    }
    if (argument === '--dry-run') {
      invariant(!options.dryRun, '--dry-run may only be provided once');
      options.dryRun = true;
      continue;
    }
    if (argument === '--concurrency' || argument.startsWith('--concurrency=')) {
      const parsed = parseOptionValue(
        argument,
        '--concurrency',
        argumentsList,
        index,
      );
      invariant(
        options.concurrency === undefined,
        '--concurrency may only be set once',
      );
      options.concurrency = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--provider' || argument.startsWith('--provider=')) {
      const parsed = parseOptionValue(
        argument,
        '--provider',
        argumentsList,
        index,
      );
      invariant(
        options.providerId === undefined,
        '--provider may only be set once',
      );
      options.providerId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--model' || argument.startsWith('--model=')) {
      const parsed = parseOptionValue(
        argument,
        '--model',
        argumentsList,
        index,
      );
      invariant(options.modelId === undefined, '--model may only be set once');
      options.modelId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--effort' || argument.startsWith('--effort=')) {
      const parsed = parseOptionValue(
        argument,
        '--effort',
        argumentsList,
        index,
      );
      invariant(
        options.effortLevel === undefined,
        '--effort may only be set once',
      );
      options.effortLevel = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--lane' || argument.startsWith('--lane=')) {
      const parsed = parseOptionValue(argument, '--lane', argumentsList, index);
      invariant(options.lane === undefined, '--lane may only be set once');
      options.lane = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--condition' || argument.startsWith('--condition=')) {
      const parsed = parseOptionValue(
        argument,
        '--condition',
        argumentsList,
        index,
      );
      invariant(
        options.condition === undefined,
        '--condition may only be set once',
      );
      options.condition = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--case' || argument.startsWith('--case=')) {
      const parsed = parseOptionValue(argument, '--case', argumentsList, index);
      options.caseIds.push(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (argument === '--output' || argument.startsWith('--output=')) {
      const parsed = parseOptionValue(
        argument,
        '--output',
        argumentsList,
        index,
      );
      invariant(
        options.outputDir === undefined,
        '--output may only be set once',
      );
      options.outputDir = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    invariant(!argument.startsWith('-'), `Unknown option: ${argument}`);
    invariant(false, `Unexpected positional argument: ${argument}`);
  }

  return options;
}

function resolveProviderId(providerId: string | undefined): CliProviderId {
  invariant(providerId !== undefined, '--provider is required');
  assertString(providerId, '--provider must be a string');
  invariant(providerId.length > 0, '--provider must not be empty');
  invariant(
    isCliProviderId(providerId),
    `Unsupported provider id: ${providerId}. Expected one of ${CLI_PROVIDER_IDS.join(', ')}`,
  );
  return providerId;
}

function resolveOptionalStringOption(
  value: string | undefined,
  optionName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  assertString(optionName, 'optionName must be a string');
  invariant(optionName.startsWith('--'), 'optionName must start with "--"');
  assertString(value, `${optionName} must be a string`);
  const trimmed = value.trim();
  invariant(trimmed.length > 0, `${optionName} must not be empty`);
  return trimmed;
}

function resolveRequestedLanes(lane: string | undefined): EvalLane[] {
  invariant(lane !== undefined, '--lane is required');
  assertString(lane, '--lane must be a string');
  invariant(lane.length > 0, '--lane must not be empty');

  if (lane === 'all') {
    return [...EVAL_LANES];
  }

  invariant(
    isEvalLane(lane),
    `Unsupported lane: ${lane}. Expected one of ${[...EVAL_LANES, 'all'].join(', ')}`,
  );
  return [lane];
}

function resolveRequestedConditions(
  condition: string | undefined,
): SkillCondition[] {
  if (condition === undefined || condition === 'all') {
    return [...SKILL_CONDITIONS];
  }

  assertString(condition, '--condition must be a string');
  invariant(condition.length > 0, '--condition must not be empty');
  invariant(
    isSkillCondition(condition),
    `Unsupported condition: ${condition}. Expected one of ${[...SKILL_CONDITIONS, 'all'].join(', ')}`,
  );
  return [condition];
}

function resolveRequestedCaseIds(caseIds: readonly string[]): string[] {
  const seenCaseIds = new Set<string>();
  const resolvedCaseIds: string[] = [];

  for (const caseId of caseIds) {
    assertString(caseId, '--case values must be strings');
    invariant(caseId.length > 0, '--case values must not be empty');
    invariant(!seenCaseIds.has(caseId), `Duplicate --case value: ${caseId}`);
    seenCaseIds.add(caseId);
    resolvedCaseIds.push(caseId);
  }

  return resolvedCaseIds;
}

function resolveConcurrency(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  invariant(
    Number.isInteger(parsed) && parsed > 0,
    `--concurrency must be a positive integer, got: ${value}`,
  );
  return parsed;
}

function resolveOutputBaseDir(
  repoRoot: string,
  outputDir: string | undefined,
): string {
  if (outputDir === undefined) {
    return resolve(
      repoRoot,
      'evals',
      'reports',
      formatTimestampForPath(new Date()),
    );
  }

  assertString(outputDir, '--output must be a string');
  invariant(outputDir.length > 0, '--output must not be empty');
  return resolve(repoRoot, outputDir);
}

function getCasesForLane(lane: EvalLane): EvalCase[] {
  switch (lane) {
    case 'prompt':
      return getAllPromptCases();
    case 'execution':
      return getAllExecutionCases();
    case 'dogfood':
      return getAllDogfoodCases();
    default:
      return lane satisfies never;
  }
}

function buildCaseSelections(
  providerId: string,
  lanes: readonly EvalLane[],
  conditions: readonly SkillCondition[],
  caseIds: readonly string[],
): {
  activeConditions: SkillCondition[];
  activeLanes: EvalLane[];
  cases: CaseSelection[];
  totalInvocations: number;
} {
  const availableCases = lanes.flatMap((lane) => getCasesForLane(lane));
  const availableCaseIds = new Set(
    availableCases.map((evalCase) => evalCase.id),
  );
  for (const caseId of caseIds) {
    invariant(
      availableCaseIds.has(caseId),
      `Unknown case id for selected lanes: ${caseId}`,
    );
  }

  const requestedCaseIds = caseIds.length === 0 ? undefined : new Set(caseIds);
  const selectedCases = availableCases.filter(
    (evalCase) =>
      requestedCaseIds === undefined || requestedCaseIds.has(evalCase.id),
  );
  invariant(
    selectedCases.length > 0,
    'No eval cases matched the requested lanes',
  );

  const requestedConditions = new Set(conditions);
  const matrixEntries = buildConditionMatrix(selectedCases, [
    providerId,
  ]).filter((entry) => requestedConditions.has(entry.condition));
  invariant(
    matrixEntries.length > 0,
    'No eval combinations matched the requested lane, condition, and case filters',
  );

  const groupedSelections = new Map<string, CaseSelection>();
  for (const entry of matrixEntries) {
    const key = `${entry.lane}::${entry.caseId}`;
    const existing = groupedSelections.get(key);
    if (existing === undefined) {
      groupedSelections.set(key, {
        lane: entry.lane,
        caseId: entry.caseId,
        category: entry.category,
        expectedSkill: entry.expectedSkill,
        conditions: [entry.condition],
        ...(entry.fixture === undefined ? {} : { fixture: entry.fixture }),
        ...(entry.target === undefined ? {} : { target: entry.target }),
      });
      continue;
    }

    if (!existing.conditions.includes(entry.condition)) {
      existing.conditions.push(entry.condition);
    }
  }

  const cases = [...groupedSelections.values()].sort(compareCaseSelection);
  for (const selection of cases) {
    selection.conditions.sort(
      (left, right) =>
        SKILL_CONDITIONS.indexOf(left) - SKILL_CONDITIONS.indexOf(right),
    );
  }

  const activeLanes = EVAL_LANES.filter((lane) =>
    matrixEntries.some((entry) => entry.lane === lane),
  );
  const activeConditions = SKILL_CONDITIONS.filter((condition) =>
    matrixEntries.some((entry) => entry.condition === condition),
  );
  const totalInvocations = matrixEntries.reduce((count, entry) => {
    return count + (entry.lane === 'prompt' ? DEFAULT_TOTAL_TRIALS : 1);
  }, 0);

  return {
    activeConditions,
    activeLanes,
    cases,
    totalInvocations,
  };
}

function buildResolvedOptions(
  repoRoot: string,
  options: CliOptions,
): ResolvedCliOptions {
  const providerId = resolveProviderId(options.providerId);
  const modelId = resolveOptionalStringOption(options.modelId, '--model');
  const effortLevel = resolveOptionalStringOption(
    options.effortLevel,
    '--effort',
  );
  const requestedLanes = resolveRequestedLanes(options.lane);
  const requestedConditions = resolveRequestedConditions(options.condition);
  const caseIds = resolveRequestedCaseIds(options.caseIds);
  const outputBaseDir = resolveOutputBaseDir(repoRoot, options.outputDir);
  const concurrency = resolveConcurrency(options.concurrency);
  const selection = buildCaseSelections(
    providerId,
    requestedLanes,
    requestedConditions,
    caseIds,
  );

  return {
    providerId,
    ...(modelId === undefined ? {} : { modelId }),
    ...(effortLevel === undefined ? {} : { effortLevel }),
    requestedLane: options.lane ?? 'all',
    requestedCondition: options.condition ?? 'all',
    caseIds,
    outputBaseDir,
    concurrency,
    json: options.json,
    verbose: options.verbose,
    dryRun: options.dryRun,
    activeLanes: selection.activeLanes,
    activeConditions: selection.activeConditions,
    selectedCases: selection.cases,
    totalInvocations: selection.totalInvocations,
  };
}

function logVerbose(options: ResolvedCliOptions, message: string): void {
  if (!options.verbose) {
    return;
  }
  writeLine(process.stderr, `[evals] ${message}`);
}

function formatOptionalValue(value: string | undefined): string {
  return value === undefined ? 'n/a' : value;
}

function formatCaseSelection(selection: CaseSelection): string {
  const conditions = selection.conditions.join(', ');
  const fixture = formatOptionalValue(selection.fixture);
  const target = formatOptionalValue(selection.target);
  return `${selection.lane} :: ${selection.caseId} [${selection.category}] conditions=${conditions} fixture=${fixture} target=${target}`;
}

function writeDryRunSummary(options: ResolvedCliOptions): void {
  const summary: RunSummary = {
    ok: true,
    providerId: options.providerId,
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    lanes: options.activeLanes,
    conditions: options.activeConditions,
    totalInvocations: options.totalInvocations,
    totalResults: 0,
    passed: 0,
    failed: 0,
    outputBaseDir: options.outputBaseDir,
    laneErrors: [],
    dryRun: true,
    selectedCases: options.selectedCases,
  };

  if (options.json) {
    writeLine(process.stdout, JSON.stringify(summary, null, 2));
    return;
  }

  writeLine(process.stdout, 'Dry run: no providers will be invoked.');
  writeLine(process.stdout, `Provider: ${options.providerId}`);
  if (options.modelId !== undefined) {
    writeLine(process.stdout, `Model: ${options.modelId}`);
  }
  if (options.effortLevel !== undefined) {
    writeLine(process.stdout, `Effort: ${options.effortLevel}`);
  }
  writeLine(process.stdout, `Lanes: ${options.activeLanes.join(', ')}`);
  writeLine(
    process.stdout,
    `Conditions: ${options.activeConditions.join(', ')}`,
  );
  writeLine(process.stdout, `Output base dir: ${options.outputBaseDir}`);
  writeLine(
    process.stdout,
    `Total eval invocations: ${String(options.totalInvocations)}`,
  );
  writeLine(process.stdout, 'Selected cases:');
  for (const selection of options.selectedCases) {
    writeLine(process.stdout, `- ${formatCaseSelection(selection)}`);
  }
}

function createEvalProvider(
  options: Pick<ResolvedCliOptions, 'providerId' | 'modelId' | 'effortLevel'>,
  repoRoot: string,
): EvalProvider {
  const providerConfig = {
    ...(options.modelId === undefined
      ? {}
      : { defaultModelId: options.modelId }),
    ...(options.providerId !== 'claude' || options.effortLevel === undefined
      ? {}
      : { env: { CLAUDE_CODE_EFFORT: options.effortLevel } }),
  };

  if (options.providerId === 'fixture') {
    const fixtureDir = process.env.EVAL_FIXTURE_DIR;
    invariant(
      typeof fixtureDir === 'string' && fixtureDir.trim().length > 0,
      'The fixture provider requires EVAL_FIXTURE_DIR to point at a fixture directory',
    );
    return createProvider(options.providerId, {
      ...providerConfig,
      fixtureDir: resolve(repoRoot, fixtureDir),
    });
  }

  return createProvider(options.providerId, providerConfig);
}

function appendMetadataNote(notes: string[], note: string | undefined): void {
  if (note === undefined) {
    return;
  }
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return;
  }
  notes.push(trimmed);
}

function buildRunMetadata(
  options: ResolvedCliOptions,
  repoRoot: string,
  runId: string,
  runtimeInfo: ProviderRuntimeInfo | undefined,
  runtimeErrorMessage: string | undefined,
): RunMetadata {
  const metadataNotes: string[] = [];
  appendMetadataNote(metadataNotes, `requested lane: ${options.requestedLane}`);
  appendMetadataNote(
    metadataNotes,
    `requested condition: ${options.requestedCondition}`,
  );
  if (options.caseIds.length > 0) {
    appendMetadataNote(
      metadataNotes,
      `case filter: ${options.caseIds.join(', ')}`,
    );
  }
  appendMetadataNote(
    metadataNotes,
    `output base dir: ${options.outputBaseDir}`,
  );
  appendMetadataNote(
    metadataNotes,
    options.modelId === undefined
      ? undefined
      : `requested model: ${options.modelId}`,
  );
  appendMetadataNote(
    metadataNotes,
    options.effortLevel === undefined
      ? undefined
      : `requested effort: ${options.effortLevel}`,
  );
  if (runtimeInfo === undefined) {
    appendMetadataNote(
      metadataNotes,
      `provider detection failed before run: ${runtimeErrorMessage ?? 'unknown error'}`,
    );
  } else {
    appendMetadataNote(
      metadataNotes,
      `provider available: ${String(runtimeInfo.available)}`,
    );
    appendMetadataNote(metadataNotes, `provider id: ${runtimeInfo.providerId}`);
    appendMetadataNote(
      metadataNotes,
      runtimeInfo.version === undefined
        ? undefined
        : `provider version: ${runtimeInfo.version}`,
    );
    appendMetadataNote(
      metadataNotes,
      runtimeInfo.commandPath === undefined
        ? undefined
        : `provider command path: ${runtimeInfo.commandPath}`,
    );
    for (const note of runtimeInfo.notes) {
      appendMetadataNote(metadataNotes, `provider note: ${note}`);
    }
  }

  const selectedModelId = options.modelId ?? runtimeInfo?.defaultModelId;
  const parsedMetadata = RunMetadataSchema.parse({
    runId,
    createdAt: new Date().toISOString(),
    repoRoot,
    providers: [options.providerId],
    models: selectedModelId === undefined ? [] : [selectedModelId],
    lanes: options.activeLanes,
    conditions: options.activeConditions,
    totalTrials: DEFAULT_TOTAL_TRIALS,
    notes: metadataNotes,
  });
  const metadata: RunMetadata = parsedMetadata;
  return metadata;
}

function buildSummary(
  options: ResolvedCliOptions,
  results: EvalResult[],
  laneErrors: readonly LaneErrorSummary[],
  metadata: RunMetadata,
  jsonReportPath: string,
  markdownReportPath: string,
  runDir: string,
): RunSummary {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const ok = failed === 0 && laneErrors.length === 0;
  return {
    ok,
    runId: metadata.runId,
    providerId: options.providerId,
    ...(metadata.models[0] === undefined
      ? {}
      : { modelId: metadata.models[0] }),
    lanes: metadata.lanes,
    conditions: metadata.conditions,
    totalInvocations: options.totalInvocations,
    totalResults: results.length,
    passed,
    failed,
    outputBaseDir: options.outputBaseDir,
    runDir,
    jsonReportPath,
    markdownReportPath,
    laneErrors: [...laneErrors],
    dryRun: false,
    selectedCases: options.selectedCases,
  };
}

function writeHumanSummary(summary: RunSummary): void {
  writeLine(
    process.stdout,
    summary.ok
      ? 'Eval run completed successfully.'
      : 'Eval run completed with failures.',
  );
  if (summary.runId !== undefined) {
    writeLine(process.stdout, `Run ID: ${summary.runId}`);
  }
  writeLine(process.stdout, `Provider: ${summary.providerId}`);
  if (summary.modelId !== undefined) {
    writeLine(process.stdout, `Model: ${summary.modelId}`);
  }
  writeLine(process.stdout, `Lanes: ${summary.lanes.join(', ')}`);
  writeLine(process.stdout, `Conditions: ${summary.conditions.join(', ')}`);
  writeLine(process.stdout, `Output base dir: ${summary.outputBaseDir}`);
  if (summary.runDir !== undefined) {
    writeLine(process.stdout, `Run dir: ${summary.runDir}`);
  }
  writeLine(
    process.stdout,
    `Expected invocations: ${String(summary.totalInvocations)}`,
  );
  writeLine(
    process.stdout,
    `Results: ${String(summary.totalResults)} total, ${String(summary.passed)} passed, ${String(summary.failed)} failed`,
  );
  if (summary.jsonReportPath !== undefined) {
    writeLine(process.stdout, `JSON report: ${summary.jsonReportPath}`);
  }
  if (summary.markdownReportPath !== undefined) {
    writeLine(process.stdout, `Markdown report: ${summary.markdownReportPath}`);
  }
  if (summary.laneErrors.length > 0) {
    writeLine(process.stdout, 'Lane errors:');
    for (const laneError of summary.laneErrors) {
      writeLine(process.stdout, `- ${laneError.lane}: ${laneError.message}`);
    }
  }
}

async function detectProviderRuntime(
  provider: EvalProvider,
  options: ResolvedCliOptions,
): Promise<{
  runtimeErrorMessage?: string;
  runtimeInfo?: ProviderRuntimeInfo;
}> {
  try {
    const runtimeInfo = await provider.detect();
    logVerbose(
      options,
      `Detected provider runtime for ${provider.id}: available=${String(runtimeInfo.available)}`,
    );
    return { runtimeInfo };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logVerbose(
      options,
      `Provider detection failed for ${provider.id}: ${message}`,
    );
    return { runtimeErrorMessage: message };
  }
}

async function runLane(
  lane: EvalLane,
  provider: EvalProvider,
  metadata: RunMetadata,
  options: ResolvedCliOptions,
): Promise<EvalResult[]> {
  const caseFilter = options.selectedCases
    .filter((selection) => selection.lane === lane)
    .map((selection) => selection.caseId);
  invariant(
    caseFilter.length > 0,
    `Lane ${lane} must have at least one selected case`,
  );

  switch (lane) {
    case 'prompt':
      return runPromptLane(provider, metadata, {
        conditions: options.activeConditions,
        caseFilter,
        concurrency: options.concurrency,
      });
    case 'execution':
      return runExecutionLane(provider, metadata, {
        conditions: options.activeConditions,
        caseFilter,
        concurrency: options.concurrency,
      });
    case 'dogfood':
      return runDogfoodLane(provider, metadata, {
        conditions: options.activeConditions,
        caseFilter,
        concurrency: options.concurrency,
      });
    default:
      return lane satisfies never;
  }
}

export async function runEvalCli(
  argumentsList: readonly string[],
): Promise<number> {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const parsedOptions = parseCliArgs(argumentsList);
  if (parsedOptions.help) {
    writeLine(process.stdout, HELP_TEXT);
    return 0;
  }

  const options = buildResolvedOptions(repoRoot, parsedOptions);
  if (options.dryRun) {
    writeDryRunSummary(options);
    return 0;
  }

  await mkdir(options.outputBaseDir, { recursive: true });
  const provider = createEvalProvider(options, repoRoot);
  const { runtimeInfo, runtimeErrorMessage } = await detectProviderRuntime(
    provider,
    options,
  );
  const metadata = buildRunMetadata(
    options,
    repoRoot,
    generateRunId(),
    runtimeInfo,
    runtimeErrorMessage,
  );
  const results: EvalResult[] = [];
  const laneErrors: LaneErrorSummary[] = [];

  for (const lane of options.activeLanes) {
    logVerbose(options, `Running ${lane} lane`);
    try {
      const laneResults = await runLane(lane, provider, metadata, options);
      results.push(...laneResults);
      logVerbose(
        options,
        `Completed ${lane} lane with ${String(laneResults.length)} result(s)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      laneErrors.push({ lane, message });
      appendMetadataNote(metadata.notes, `lane ${lane} failed: ${message}`);
      logVerbose(options, `Lane ${lane} failed: ${message}`);
    }
  }

  const comparisonMetrics =
    options.activeConditions.length > 1
      ? computeComparisonMetrics(results)
      : [];
  const jsonReport = generateJsonReport(results, metadata, comparisonMetrics);
  const markdownReport = generateMarkdownReport(
    results,
    metadata,
    comparisonMetrics,
  );

  const artifactStore = new EvalArtifactStore(options.outputBaseDir);
  await artifactStore.saveRunMetadata(metadata.runId, metadata);
  const runDir = artifactStore.runDir(metadata.runId);
  await mkdir(runDir, { recursive: true });

  const jsonReportPath = join(runDir, 'report.json');
  const markdownReportPath = join(runDir, 'report.md');
  await writeFile(
    jsonReportPath,
    `${JSON.stringify(jsonReport, null, 2)}\n`,
    'utf8',
  );
  await writeFile(markdownReportPath, markdownReport, 'utf8');

  const summary = buildSummary(
    options,
    results,
    laneErrors,
    metadata,
    jsonReportPath,
    markdownReportPath,
    runDir,
  );

  if (options.json) {
    writeLine(process.stdout, JSON.stringify(summary, null, 2));
  } else {
    writeHumanSummary(summary);
  }

  return summary.ok ? 0 : 1;
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isDirectExecution()) {
  try {
    process.exitCode = await runEvalCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) {
      writeLine(
        process.stdout,
        JSON.stringify({ ok: false, error: message }, null, 2),
      );
    } else {
      writeLine(process.stderr, message);
    }
    process.exitCode = 1;
  }
}
