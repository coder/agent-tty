import { mkdir, readFile } from 'node:fs/promises';
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
import {
  buildBaselineComparison,
  generateJsonReport,
} from './lib/reporting.js';
import { JsonReportSchema, RunMetadataSchema } from './lib/schemas.js';
import {
  aggregateTokenRecords,
  type RawTokenRecord,
} from './lib/tokenAggregation.js';
import {
  buildWorkItemKey,
  type EvalCase,
  type EvalLane,
  type EvalResult,
  type JsonReport,
  type ProviderRuntimeInfo,
  type RunMetadata,
  type SkillCondition,
  type TokenReportSummary,
} from './lib/types.js';
import { getAllPromptCases, runPromptLane } from './prompt/runner.js';
import { createProvider, SUPPORTED_PROVIDER_IDS } from './providers/base.js';
import { ConsoleReporter } from './reporters/console.js';
import { ReporterDispatcher } from './reporters/dispatch.js';
import {
  FinalReportReporter,
  type FinalReportInputs,
} from './reporters/final-report.js';
import { JsonlReporter } from './reporters/jsonl.js';
import { compareSnapshotRecords } from './snapshots/compare.js';
import { caseFingerprint } from './snapshots/fingerprint.js';
import {
  buildSnapshotLogicalKey,
  type SnapshotEntry,
} from './snapshots/schema.js';
import { loadSnapshotFile, writeSnapshotFile } from './snapshots/store.js';
import { registerBuiltinPresets } from './workspaces/builtins.js';
import type { EvalProvider } from './providers/base.js';
import type {
  SnapshotCheckCase,
  SnapshotCheckReport,
  SnapshotCheckSummary,
} from './snapshots/schemas/report.js';

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
const REPORTER_IDS = ['final', 'console', 'jsonl'] as const;
const REPORTER_SET = new Set<string>(REPORTER_IDS);
export type ReporterId = (typeof REPORTER_IDS)[number];
type SnapshotMode = 'off' | 'update' | 'check';

const HELP_TEXT = [
  'Usage: npx tsx evals/run.ts [options]',
  '',
  'Options:',
  `  --provider <id>     Provider to use (${CLI_PROVIDER_IDS.join(', ')})`,
  '  --model <model>     Model to use (for example: opus, claude-opus-4-6, gpt-5.4, o4-mini)',
  '  --effort <level>    Claude Code effort/thinking level (low, medium, high, max)',
  '  --lane <lane>       Lane to run (prompt, execution, dogfood, all)',
  '  --condition <cond>  Skill condition (none, self-load, preloaded, stale, all). Default: all. May be repeated.',
  '  --case <id>         Run specific case(s) by ID. May be repeated.',
  '  --output <dir>      Output directory. Default: evals/reports/{timestamp}',
  '  --snapshot-update   Write token usage snapshots for the selected cases',
  '  --snapshot-check    Compare token usage against saved snapshots',
  '  --snapshot-threshold <percent>  Regression threshold percent for snapshot checks. Default: 20',
  '  --snapshot-dir <path>  Snapshot directory. Default: <output>/snapshots',
  `  --reporter <name>   Reporter to enable (${REPORTER_IDS.join(', ')}). May be repeated.`,
  '  --reporter-output <path>  Output path for reporters that write files (required for jsonl)',
  '  --progress          Enable progress reporting on stderr',
  '  --json              Print JSON summary only',
  '  --verbose           Print verbose progress logs to stderr',
  '  --dry-run           List cases that would run without invoking providers',
  '  --concurrency <n>  Maximum work items to run concurrently per lane. Default: 1',
  '  --trials <n>       Number of independent trials per case/condition. Default: 1',
  '  --compare-baseline <path>  Path to a prior report.json for paired baseline comparison',
  '  --help              Show this help text',
  '',
  'Examples:',
  '  npx tsx evals/run.ts --provider stub --lane prompt',
  '  npx tsx evals/run.ts --provider claude --model opus --effort high --lane prompt',
  '  npx tsx evals/run.ts --provider codex --model gpt-5.4 --lane all',
  '  npx tsx evals/run.ts --provider stub --lane execution --case hello-prompt --case resize-demo',
  '  npx tsx evals/run.ts --provider stub --lane execution --condition none --condition preloaded --dry-run',
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
  conditions: string[];
  caseIds: string[];
  reporters: string[];
  outputDir?: string;
  reporterOutput?: string;
  concurrency?: string;
  trials?: string;
  compareBaseline?: string;
  snapshotThreshold?: string;
  snapshotDir?: string;
  snapshotUpdate: boolean;
  snapshotCheck: boolean;
  json: boolean;
  verbose: boolean;
  dryRun: boolean;
  progress: boolean;
  help: boolean;
}

export interface ResolvedReporterSelection {
  reporterNames: ReporterId[];
  reporterOutputPath?: string;
}

interface ResolvedSnapshotOptions {
  snapshotMode: SnapshotMode;
  snapshotThresholdPercent: number;
  snapshotDir: string;
}

interface ResolvedCliOptions {
  providerId: string;
  modelId?: string;
  effortLevel?: string;
  requestedLane: string;
  requestedConditions: string[];
  caseIds: string[];
  outputBaseDir: string;
  compareBaselinePath?: string;
  snapshotMode: SnapshotMode;
  snapshotThresholdPercent: number;
  snapshotDir: string;
  reporterNames: ReporterId[];
  reporterOutputPath?: string;
  concurrency: number;
  totalTrials: number;
  json: boolean;
  verbose: boolean;
  dryRun: boolean;
  activeLanes: EvalLane[];
  activeConditions: SkillCondition[];
  selectedCases: CaseSelection[];
  compiledCasesBySelection: ReadonlyMap<string, EvalCase>;
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

function isReporterId(value: string): value is ReporterId {
  return REPORTER_SET.has(value);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareLane(left: EvalLane, right: EvalLane): number {
  return EVAL_LANES.indexOf(left) - EVAL_LANES.indexOf(right);
}

function compareCondition(left: SkillCondition, right: SkillCondition): number {
  return SKILL_CONDITIONS.indexOf(left) - SKILL_CONDITIONS.indexOf(right);
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

function buildSelectedCaseKey(lane: EvalLane, caseId: string): string {
  assertString(caseId, 'caseId must be a string');
  invariant(caseId.length > 0, 'caseId must not be empty');
  return `${lane}::${caseId}`;
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

export function parseCliArgs(argumentsList: readonly string[]): CliOptions {
  const options: CliOptions = {
    conditions: [],
    caseIds: [],
    reporters: [],
    snapshotUpdate: false,
    snapshotCheck: false,
    json: false,
    verbose: false,
    dryRun: false,
    progress: false,
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
    if (argument === '--progress') {
      invariant(!options.progress, '--progress may only be provided once');
      options.progress = true;
      continue;
    }
    if (argument === '--snapshot-update') {
      invariant(
        !options.snapshotUpdate,
        '--snapshot-update may only be provided once',
      );
      options.snapshotUpdate = true;
      continue;
    }
    if (argument === '--snapshot-check') {
      invariant(
        !options.snapshotCheck,
        '--snapshot-check may only be provided once',
      );
      options.snapshotCheck = true;
      continue;
    }
    if (
      argument === '--snapshot-threshold' ||
      argument.startsWith('--snapshot-threshold=')
    ) {
      const parsed = parseOptionValue(
        argument,
        '--snapshot-threshold',
        argumentsList,
        index,
      );
      invariant(
        options.snapshotThreshold === undefined,
        '--snapshot-threshold may only be set once',
      );
      options.snapshotThreshold = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (
      argument === '--snapshot-dir' ||
      argument.startsWith('--snapshot-dir=')
    ) {
      const parsed = parseOptionValue(
        argument,
        '--snapshot-dir',
        argumentsList,
        index,
      );
      invariant(
        options.snapshotDir === undefined,
        '--snapshot-dir may only be set once',
      );
      options.snapshotDir = parsed.value;
      index = parsed.nextIndex;
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
    if (argument === '--trials' || argument.startsWith('--trials=')) {
      const parsed = parseOptionValue(
        argument,
        '--trials',
        argumentsList,
        index,
      );
      invariant(options.trials === undefined, '--trials may only be set once');
      options.trials = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (
      argument === '--compare-baseline' ||
      argument.startsWith('--compare-baseline=')
    ) {
      const parsed = parseOptionValue(
        argument,
        '--compare-baseline',
        argumentsList,
        index,
      );
      invariant(
        options.compareBaseline === undefined,
        '--compare-baseline may only be set once',
      );
      options.compareBaseline = parsed.value;
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
      options.conditions.push(parsed.value);
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
    if (argument === '--reporter' || argument.startsWith('--reporter=')) {
      const parsed = parseOptionValue(
        argument,
        '--reporter',
        argumentsList,
        index,
      );
      options.reporters.push(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (
      argument === '--reporter-output' ||
      argument.startsWith('--reporter-output=')
    ) {
      const parsed = parseOptionValue(
        argument,
        '--reporter-output',
        argumentsList,
        index,
      );
      invariant(
        options.reporterOutput === undefined,
        '--reporter-output may only be set once',
      );
      options.reporterOutput = parsed.value;
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

export function resolveRequestedConditions(
  conditions: readonly string[],
): SkillCondition[] {
  invariant(Array.isArray(conditions), '--condition values must be an array');
  if (conditions.length === 0) {
    return [...SKILL_CONDITIONS];
  }

  let requestedAll = false;
  const requestedConditions = new Set<SkillCondition>();
  for (const condition of conditions) {
    assertString(condition, '--condition values must be strings');
    invariant(condition.length > 0, '--condition values must not be empty');
    if (condition === 'all') {
      requestedAll = true;
      continue;
    }
    invariant(
      isSkillCondition(condition),
      `Unsupported condition: ${condition}. Expected one of ${[...SKILL_CONDITIONS, 'all'].join(', ')}`,
    );
    invariant(
      !requestedAll,
      '--condition all may not be combined with specific values',
    );
    requestedConditions.add(condition);
  }

  if (requestedAll) {
    invariant(
      requestedConditions.size === 0,
      '--condition all may not be combined with specific values',
    );
    return [...SKILL_CONDITIONS];
  }

  return SKILL_CONDITIONS.filter((condition) =>
    requestedConditions.has(condition),
  );
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

function resolveTotalTrials(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TOTAL_TRIALS;
  }
  const parsed = Number(value);
  invariant(
    Number.isInteger(parsed) && parsed > 0,
    `--trials must be a positive integer, got: ${value}`,
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

function resolveSnapshotOptions(
  repoRoot: string,
  outputBaseDir: string,
  options: Pick<
    CliOptions,
    'snapshotCheck' | 'snapshotDir' | 'snapshotThreshold' | 'snapshotUpdate'
  >,
): ResolvedSnapshotOptions {
  invariant(
    !(options.snapshotUpdate && options.snapshotCheck),
    '--snapshot-update and --snapshot-check may not be combined',
  );

  const snapshotThresholdValue =
    options.snapshotThreshold === undefined ? '20' : options.snapshotThreshold;
  const snapshotThresholdPercent = Number(snapshotThresholdValue);
  invariant(
    Number.isFinite(snapshotThresholdPercent) &&
      snapshotThresholdPercent >= 0 &&
      snapshotThresholdPercent <= 100,
    `--snapshot-threshold must be a number between 0 and 100, got: ${snapshotThresholdValue}`,
  );

  const snapshotDirValue = resolveOptionalStringOption(
    options.snapshotDir,
    '--snapshot-dir',
  );

  return {
    snapshotMode: options.snapshotUpdate
      ? 'update'
      : options.snapshotCheck
        ? 'check'
        : 'off',
    snapshotThresholdPercent,
    snapshotDir:
      snapshotDirValue === undefined
        ? resolve(outputBaseDir, 'snapshots')
        : resolve(repoRoot, snapshotDirValue),
  };
}

export function resolveReporterSelection(
  repoRoot: string,
  options: Pick<CliOptions, 'progress' | 'reporters' | 'reporterOutput'>,
): ResolvedReporterSelection {
  assertString(repoRoot, 'repoRoot must be a string');
  invariant(repoRoot.length > 0, 'repoRoot must not be empty');
  invariant(
    Array.isArray(options.reporters),
    '--reporter values must be an array',
  );
  invariant(
    typeof options.progress === 'boolean',
    '--progress must be a boolean',
  );

  const explicit = options.reporters ?? [];
  const ordered = explicit.length === 0 ? ['final'] : [...explicit];
  if (options.progress && !ordered.includes('console')) {
    ordered.push('console');
  }

  for (const reporterName of ordered) {
    assertString(reporterName, '--reporter values must be strings');
    invariant(reporterName.length > 0, '--reporter values must not be empty');
    invariant(
      isReporterId(reporterName),
      `Unsupported reporter: ${reporterName}. Expected one of ${REPORTER_IDS.join(', ')}`,
    );
  }

  const reporterOutputPath = resolveOptionalStringOption(
    options.reporterOutput,
    '--reporter-output',
  );
  invariant(
    !ordered.includes('jsonl') || reporterOutputPath !== undefined,
    '--reporter jsonl requires --reporter-output',
  );

  return {
    reporterNames: ordered as ReporterId[],
    ...(reporterOutputPath === undefined
      ? {}
      : { reporterOutputPath: resolve(repoRoot, reporterOutputPath) }),
  };
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
  totalTrials: number,
): {
  activeConditions: SkillCondition[];
  activeLanes: EvalLane[];
  cases: CaseSelection[];
  compiledCasesBySelection: ReadonlyMap<string, EvalCase>;
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

  const compiledCasesBySelection = new Map<string, EvalCase>();
  for (const compiledCase of selectedCases) {
    const selectionKey = buildSelectedCaseKey(
      compiledCase.lane,
      compiledCase.id,
    );
    invariant(
      !compiledCasesBySelection.has(selectionKey),
      `Duplicate compiled eval case selection: ${selectionKey}`,
    );
    compiledCasesBySelection.set(selectionKey, compiledCase);
  }

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
    const key = buildSelectedCaseKey(entry.lane, entry.caseId);
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
    selection.conditions.sort(compareCondition);
  }

  const activeLanes = EVAL_LANES.filter((lane) =>
    matrixEntries.some((entry) => entry.lane === lane),
  );
  const activeConditions = SKILL_CONDITIONS.filter((condition) =>
    matrixEntries.some((entry) => entry.condition === condition),
  );
  const totalInvocations = matrixEntries.reduce((count) => {
    return count + totalTrials;
  }, 0);

  return {
    activeConditions,
    activeLanes,
    cases,
    compiledCasesBySelection,
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
  const requestedConditions = resolveRequestedConditions(options.conditions);
  const requestedConditionFilters =
    options.conditions.length === 0 ||
    options.conditions.some((condition) => condition === 'all')
      ? ['all']
      : [...requestedConditions];
  const caseIds = resolveRequestedCaseIds(options.caseIds);
  const outputBaseDir = resolveOutputBaseDir(repoRoot, options.outputDir);
  const snapshotOptions = resolveSnapshotOptions(
    repoRoot,
    outputBaseDir,
    options,
  );
  const compareBaselinePath = resolveOptionalStringOption(
    options.compareBaseline,
    '--compare-baseline',
  );
  const reporterSelection = resolveReporterSelection(repoRoot, options);
  const concurrency = resolveConcurrency(options.concurrency);
  const totalTrials = resolveTotalTrials(options.trials);
  const selection = buildCaseSelections(
    providerId,
    requestedLanes,
    requestedConditions,
    caseIds,
    totalTrials,
  );

  return {
    providerId,
    ...(modelId === undefined ? {} : { modelId }),
    ...(effortLevel === undefined ? {} : { effortLevel }),
    requestedLane: options.lane ?? 'all',
    requestedConditions: requestedConditionFilters,
    caseIds,
    outputBaseDir,
    snapshotMode: snapshotOptions.snapshotMode,
    snapshotThresholdPercent: snapshotOptions.snapshotThresholdPercent,
    snapshotDir: snapshotOptions.snapshotDir,
    ...(compareBaselinePath === undefined
      ? {}
      : { compareBaselinePath: resolve(repoRoot, compareBaselinePath) }),
    reporterNames: reporterSelection.reporterNames,
    ...(reporterSelection.reporterOutputPath === undefined
      ? {}
      : { reporterOutputPath: reporterSelection.reporterOutputPath }),
    concurrency,
    totalTrials,
    json: options.json,
    verbose: options.verbose,
    dryRun: options.dryRun,
    activeLanes: selection.activeLanes,
    activeConditions: selection.activeConditions,
    selectedCases: selection.cases,
    compiledCasesBySelection: selection.compiledCasesBySelection,
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
  writeLine(process.stdout, `Output directory: ${options.outputBaseDir}`);
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
  invariant(
    options.requestedConditions.length > 0,
    'resolved requestedConditions must contain at least one value',
  );
  appendMetadataNote(
    metadataNotes,
    `requested conditions: ${options.requestedConditions.join(', ')}`,
  );
  if (options.caseIds.length > 0) {
    appendMetadataNote(
      metadataNotes,
      `case filter: ${options.caseIds.join(', ')}`,
    );
  }
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
    outputBaseDir: options.outputBaseDir,
    providers: [options.providerId],
    models: selectedModelId === undefined ? [] : [selectedModelId],
    lanes: options.activeLanes,
    conditions: options.activeConditions,
    totalTrials: options.totalTrials,
    notes: metadataNotes,
  });
  const metadata: RunMetadata = parsedMetadata;
  return metadata;
}

async function loadBaselineReport(path: string): Promise<JsonReport> {
  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text) as JsonReport & Record<string, unknown>;
  return JsonReportSchema.parse({
    metadata: parsed.metadata,
    aggregate: parsed.aggregate,
    comparisons: parsed.comparisons,
    results: parsed.results,
    ...(parsed.providerComparison === undefined
      ? {}
      : { providerComparison: parsed.providerComparison }),
    ...(parsed.aggregated === undefined
      ? {}
      : { aggregated: parsed.aggregated }),
    ...(parsed.baselineComparison === undefined
      ? {}
      : { baselineComparison: parsed.baselineComparison }),
  }) as JsonReport;
}

function buildSummary(
  options: ResolvedCliOptions,
  results: EvalResult[],
  laneErrors: readonly LaneErrorSummary[],
  metadata: RunMetadata,
  jsonReportPath: string | undefined,
  markdownReportPath: string | undefined,
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
    ...(jsonReportPath === undefined ? {} : { jsonReportPath }),
    ...(markdownReportPath === undefined ? {} : { markdownReportPath }),
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
  writeLine(process.stdout, `Output directory: ${summary.outputBaseDir}`);
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

function createReporterDispatcher(
  options: Pick<
    ResolvedCliOptions,
    'reporterNames' | 'reporterOutputPath' | 'verbose'
  >,
  getFinalReportInputs: () => FinalReportInputs | null,
): ReporterDispatcher {
  const reporters = options.reporterNames.map((reporterName) => {
    switch (reporterName) {
      case 'console':
        return new ConsoleReporter({ verbose: options.verbose });
      case 'jsonl':
        invariant(
          options.reporterOutputPath !== undefined,
          'jsonl reporter requires an output path',
        );
        return new JsonlReporter({ outputPath: options.reporterOutputPath });
      case 'final':
        return new FinalReportReporter({ getFinalReportInputs });
      default:
        return reporterName satisfies never;
    }
  });

  return new ReporterDispatcher(reporters);
}

function resolveReporterModel(metadata: RunMetadata): string {
  return metadata.models[0] ?? 'unknown';
}

function buildRunResultCounts(results: readonly EvalResult[]): {
  total: number;
  passed: number;
  failed: number;
  errored: number;
} {
  return results.reduce(
    (counts, result) => {
      counts.total += 1;
      if (result.ok) {
        counts.passed += 1;
      } else if (result.errorClass === undefined) {
        counts.failed += 1;
      } else {
        counts.errored += 1;
      }
      return counts;
    },
    { total: 0, passed: 0, failed: 0, errored: 0 },
  );
}

interface ReducedSnapshotRecord {
  provider: string;
  model: string;
  lane: EvalLane;
  caseId: string;
  condition: SkillCondition;
  caseFingerprint: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  trials: number;
}

function compareSnapshotIdentity(
  left: Pick<
    ReducedSnapshotRecord,
    'provider' | 'model' | 'lane' | 'caseId' | 'condition' | 'caseFingerprint'
  >,
  right: Pick<
    ReducedSnapshotRecord,
    'provider' | 'model' | 'lane' | 'caseId' | 'condition' | 'caseFingerprint'
  >,
): number {
  const providerComparison = compareStrings(left.provider, right.provider);
  if (providerComparison !== 0) {
    return providerComparison;
  }
  const modelComparison = compareStrings(left.model, right.model);
  if (modelComparison !== 0) {
    return modelComparison;
  }
  const laneComparison = compareLane(left.lane, right.lane);
  if (laneComparison !== 0) {
    return laneComparison;
  }
  const caseComparison = compareStrings(left.caseId, right.caseId);
  if (caseComparison !== 0) {
    return caseComparison;
  }
  const conditionComparison = compareCondition(left.condition, right.condition);
  if (conditionComparison !== 0) {
    return conditionComparison;
  }
  return compareStrings(left.caseFingerprint, right.caseFingerprint);
}

function buildRawTokenRecords(
  results: readonly EvalResult[],
  metadata: RunMetadata,
  compiledCasesBySelection: ReadonlyMap<string, EvalCase>,
): RawTokenRecord[] {
  const fingerprintBySelection = new Map<string, string>();
  const rawTokenRecords: RawTokenRecord[] = [];

  for (const result of results) {
    const tokenUsage = result.normalizedOutput.tokenUsage;
    if (tokenUsage === undefined) {
      continue;
    }

    const selectionKey = buildSelectedCaseKey(result.lane, result.caseId);
    let fingerprint = fingerprintBySelection.get(selectionKey);
    if (fingerprint === undefined) {
      const compiledCase = compiledCasesBySelection.get(selectionKey);
      invariant(
        compiledCase !== undefined,
        `Missing compiled eval case for token record: ${selectionKey}`,
      );
      fingerprint = caseFingerprint(compiledCase);
      fingerprintBySelection.set(selectionKey, fingerprint);
    }

    rawTokenRecords.push({
      provider: result.providerId,
      model: result.modelId ?? metadata.models[0] ?? 'unknown',
      lane: result.lane,
      caseId: result.caseId,
      condition: result.condition,
      caseFingerprint: fingerprint,
      usage: tokenUsage,
    });
  }

  return rawTokenRecords;
}

function reduceSnapshotTokenRecords(
  records: readonly RawTokenRecord[],
): ReducedSnapshotRecord[] {
  const groupedRecords = new Map<
    string,
    ReducedSnapshotRecord & {
      cachedTokensTotal: number;
      sawMissingCachedTokens: boolean;
    }
  >();

  for (const record of records) {
    const key = JSON.stringify([
      record.provider,
      record.model,
      record.lane,
      record.caseId,
      record.condition,
      record.caseFingerprint,
    ]);
    const existing = groupedRecords.get(key);
    if (existing === undefined) {
      groupedRecords.set(key, {
        provider: record.provider,
        model: record.model,
        lane: record.lane,
        caseId: record.caseId,
        condition: record.condition,
        caseFingerprint: record.caseFingerprint,
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        totalTokens: record.usage.totalTokens,
        trials: 1,
        cachedTokensTotal: record.usage.cachedTokens ?? 0,
        sawMissingCachedTokens: record.usage.cachedTokens === undefined,
      });
      continue;
    }

    existing.inputTokens += record.usage.inputTokens;
    existing.outputTokens += record.usage.outputTokens;
    existing.totalTokens += record.usage.totalTokens;
    existing.trials += 1;
    if (record.usage.cachedTokens === undefined) {
      existing.sawMissingCachedTokens = true;
    } else {
      existing.cachedTokensTotal += record.usage.cachedTokens;
    }
  }

  return [...groupedRecords.values()]
    .map(({ cachedTokensTotal, sawMissingCachedTokens, ...record }) => ({
      ...record,
      ...(sawMissingCachedTokens ? {} : { cachedTokens: cachedTokensTotal }),
    }))
    .sort(compareSnapshotIdentity);
}

function buildValidSnapshotLogicalKeys(
  options: Pick<
    ResolvedCliOptions,
    'compiledCasesBySelection' | 'selectedCases'
  >,
): ReadonlySet<string> {
  const validCurrentKeys = new Set<string>();

  for (const selection of options.selectedCases) {
    const selectionKey = buildSelectedCaseKey(selection.lane, selection.caseId);
    const compiledCase = options.compiledCasesBySelection.get(selectionKey);
    invariant(
      compiledCase !== undefined,
      `Missing compiled eval case for snapshot selection: ${selectionKey}`,
    );
    const fingerprint = caseFingerprint(compiledCase);
    for (const condition of selection.conditions) {
      validCurrentKeys.add(
        buildSnapshotLogicalKey({
          lane: selection.lane,
          caseId: selection.caseId,
          condition,
          caseFingerprint: fingerprint,
        }),
      );
    }
  }

  return validCurrentKeys;
}

function mergeSnapshotCheckReports(
  reports: readonly SnapshotCheckReport[],
  regressionThresholdPercent: number,
): SnapshotCheckReport {
  const summary: SnapshotCheckSummary = {
    total: 0,
    new: 0,
    orphaned: 0,
    unchanged: 0,
    improved: 0,
    regressed: 0,
  };
  const cases: SnapshotCheckCase[] = [];

  for (const report of reports) {
    invariant(
      report.regressionThresholdPercent === regressionThresholdPercent,
      'snapshot check regression threshold must stay consistent across groups',
    );
    summary.total += report.summary.total;
    summary.new += report.summary.new;
    summary.orphaned += report.summary.orphaned;
    summary.unchanged += report.summary.unchanged;
    summary.improved += report.summary.improved;
    summary.regressed += report.summary.regressed;
    cases.push(...report.cases);
  }

  cases.sort(compareSnapshotIdentity);
  return {
    regressionThresholdPercent,
    cases,
    summary,
  };
}

async function buildTokenReport(
  results: readonly EvalResult[],
  metadata: RunMetadata,
  options: Pick<
    ResolvedCliOptions,
    | 'activeLanes'
    | 'compiledCasesBySelection'
    | 'selectedCases'
    | 'snapshotDir'
    | 'snapshotMode'
    | 'snapshotThresholdPercent'
  >,
): Promise<TokenReportSummary | undefined> {
  const rawTokenRecords = buildRawTokenRecords(
    results,
    metadata,
    options.compiledCasesBySelection,
  );
  if (rawTokenRecords.length === 0) {
    return undefined;
  }

  const tokenReport = aggregateTokenRecords(
    rawTokenRecords,
    options.activeLanes,
  );
  invariant(
    tokenReport !== undefined,
    'token report must exist for token records',
  );
  if (options.snapshotMode === 'off') {
    return tokenReport;
  }

  const reducedSnapshotRecords = reduceSnapshotTokenRecords(rawTokenRecords);
  const groupedSnapshotRecords = new Map<
    string,
    {
      provider: string;
      model: string;
      records: ReducedSnapshotRecord[];
    }
  >();
  for (const record of reducedSnapshotRecords) {
    const groupKey = JSON.stringify([record.provider, record.model]);
    const existingGroup = groupedSnapshotRecords.get(groupKey);
    if (existingGroup === undefined) {
      groupedSnapshotRecords.set(groupKey, {
        provider: record.provider,
        model: record.model,
        records: [record],
      });
      continue;
    }
    existingGroup.records.push(record);
  }

  const sortedGroups = [...groupedSnapshotRecords.values()].sort(
    (left, right) => {
      const providerComparison = compareStrings(left.provider, right.provider);
      if (providerComparison !== 0) {
        return providerComparison;
      }
      return compareStrings(left.model, right.model);
    },
  );

  if (options.snapshotMode === 'update') {
    const createdAtMs = Date.now();
    for (const group of sortedGroups) {
      const entries: SnapshotEntry[] = group.records.map((record) => ({
        provider: record.provider,
        model: record.model,
        lane: record.lane,
        caseId: record.caseId,
        condition: record.condition,
        caseFingerprint: record.caseFingerprint,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        createdAtMs,
        ...(record.cachedTokens === undefined
          ? {}
          : { cachedTokens: record.cachedTokens }),
      }));
      await writeSnapshotFile({
        snapshotDir: options.snapshotDir,
        provider: group.provider,
        model: group.model,
        entries,
      });
    }
    return tokenReport;
  }

  const validCurrentKeys = buildValidSnapshotLogicalKeys(options);
  const snapshotReports: SnapshotCheckReport[] = [];
  for (const group of sortedGroups) {
    const snapshotFile = await loadSnapshotFile({
      snapshotDir: options.snapshotDir,
      provider: group.provider,
      model: group.model,
      validCurrentKeys,
    });
    snapshotReports.push(
      compareSnapshotRecords({
        currentRecords: group.records.map((record) => ({
          provider: record.provider,
          model: record.model,
          lane: record.lane,
          caseId: record.caseId,
          condition: record.condition,
          caseFingerprint: record.caseFingerprint,
          totalTokens: record.totalTokens,
        })),
        snapshotRecords: snapshotFile.entries.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          lane: entry.lane,
          caseId: entry.caseId,
          condition: entry.condition,
          caseFingerprint: entry.caseFingerprint,
          totalTokens: entry.totalTokens,
        })),
        regressionThresholdPercent: options.snapshotThresholdPercent,
      }),
    );
  }

  return {
    ...tokenReport,
    snapshotCheck: mergeSnapshotCheckReports(
      snapshotReports,
      options.snapshotThresholdPercent,
    ),
  };
}

async function runLane(
  lane: EvalLane,
  provider: EvalProvider,
  metadata: RunMetadata,
  options: ResolvedCliOptions,
  reporter: ReporterDispatcher,
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
        reporter,
      });
    case 'execution':
      return runExecutionLane(provider, metadata, {
        conditions: options.activeConditions,
        caseFilter,
        concurrency: options.concurrency,
        reporter,
      });
    case 'dogfood':
      return runDogfoodLane(provider, metadata, {
        conditions: options.activeConditions,
        caseFilter,
        concurrency: options.concurrency,
        reporter,
      });
    default:
      return lane satisfies never;
  }
}

function recordLaneFailure(
  lane: EvalLane,
  message: string,
  laneErrors: LaneErrorSummary[],
  metadata: RunMetadata,
  options: ResolvedCliOptions,
): void {
  laneErrors.push({ lane, message });
  appendMetadataNote(metadata.notes, `lane ${lane} failed: ${message}`);
  logVerbose(options, `Lane ${lane} failed: ${message}`);
}

export async function runEvalCli(
  argumentsList: readonly string[],
): Promise<number> {
  registerBuiltinPresets();

  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const parsedOptions = parseCliArgs(argumentsList);
  if (parsedOptions.help) {
    writeLine(process.stdout, HELP_TEXT);
    return 0;
  }

  const options = buildResolvedOptions(repoRoot, parsedOptions);
  let finalReportInputs: FinalReportInputs | null = null;
  const getFinalReportInputs = (): FinalReportInputs | null =>
    finalReportInputs;
  const reporter = createReporterDispatcher(options, getFinalReportInputs);
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
  const runStartedAtMs = Date.parse(metadata.createdAt);
  await reporter.dispatch('runStart', {
    runId: metadata.runId,
    provider: options.providerId,
    model: resolveReporterModel(metadata),
    lanes: metadata.lanes,
    conditions: metadata.conditions,
    totalTrials: options.totalTrials,
    totalInvocations: options.totalInvocations,
    outputDir: options.outputBaseDir,
    startedAt: metadata.createdAt,
  });

  if (options.concurrency > 1) {
    const lanePromises = options.activeLanes.map(async (lane) => {
      try {
        logVerbose(options, `Running ${lane} lane`);
        const laneResults = await runLane(
          lane,
          provider,
          metadata,
          options,
          reporter,
        );
        logVerbose(
          options,
          `Completed ${lane} lane with ${String(laneResults.length)} result(s)`,
        );
        return { lane, results: laneResults } as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { lane, error: message } as const;
      }
    });
    const settled = await Promise.allSettled(lanePromises);
    for (const [index, outcome] of settled.entries()) {
      const lane = options.activeLanes[index];
      invariant(
        lane !== undefined,
        `Missing active lane for settled outcome at index ${String(index)}`,
      );
      if (outcome.status === 'rejected') {
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        recordLaneFailure(lane, message, laneErrors, metadata, options);
        continue;
      }
      if ('error' in outcome.value) {
        recordLaneFailure(
          outcome.value.lane,
          outcome.value.error,
          laneErrors,
          metadata,
          options,
        );
        continue;
      }
      results.push(...outcome.value.results);
    }
  } else {
    for (const lane of options.activeLanes) {
      logVerbose(options, `Running ${lane} lane`);
      try {
        const laneResults = await runLane(
          lane,
          provider,
          metadata,
          options,
          reporter,
        );
        results.push(...laneResults);
        logVerbose(
          options,
          `Completed ${lane} lane with ${String(laneResults.length)} result(s)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordLaneFailure(lane, message, laneErrors, metadata, options);
      }
    }
  }

  results.sort((left, right) =>
    buildWorkItemKey(left).localeCompare(buildWorkItemKey(right)),
  );

  const comparisonMetrics =
    options.activeConditions.length > 1
      ? computeComparisonMetrics(results)
      : [];
  const candidateCoreReport = generateJsonReport(
    results,
    metadata,
    comparisonMetrics,
  );
  const baselineComparison =
    options.compareBaselinePath === undefined
      ? undefined
      : buildBaselineComparison(
          await loadBaselineReport(options.compareBaselinePath),
          candidateCoreReport,
        );
  const tokenReport = await buildTokenReport(results, metadata, options);
  const artifactStore = new EvalArtifactStore(options.outputBaseDir);
  await artifactStore.saveRunMetadata(metadata.runId, metadata);
  const runDir = artifactStore.runDir(metadata.runId);
  await mkdir(runDir, { recursive: true });

  const jsonReportPath = join(runDir, 'report.json');
  const markdownReportPath = join(runDir, 'report.md');
  const finalReporterEnabled = options.reporterNames.includes('final');
  if (finalReporterEnabled) {
    finalReportInputs = {
      results,
      metadata,
      comparisonMetrics,
      ...(baselineComparison === undefined ? {} : { baselineComparison }),
      jsonReportPath,
      markdownReportPath,
    };
  }

  const runCompletedAt = new Date().toISOString();
  await reporter.dispatch('runFinish', {
    runId: metadata.runId,
    startedAt: metadata.createdAt,
    completedAt: runCompletedAt,
    durationMs: Math.max(0, Date.parse(runCompletedAt) - runStartedAtMs),
    ...buildRunResultCounts(results),
    laneErrors: [...laneErrors],
    runDir,
    reportJsonPath: finalReporterEnabled ? jsonReportPath : null,
    reportMarkdownPath: finalReporterEnabled ? markdownReportPath : null,
    ...(tokenReport === undefined ? {} : { tokenReport }),
  });

  const summary = buildSummary(
    options,
    results,
    laneErrors,
    metadata,
    finalReporterEnabled ? jsonReportPath : undefined,
    finalReporterEnabled ? markdownReportPath : undefined,
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
