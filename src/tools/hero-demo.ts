import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, statSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../util/isDirectExecution.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BUNDLE_DIR = join(REPO_ROOT, 'dogfood/agent-uses-agent-tty');
const DEFAULT_SENTENCE =
  'agent-tty nested Neovim proof from a real coding agent.';
const DEFAULT_RECORD_SECONDS = 180;
const AGENTS = ['codex', 'claude'] as const;

const OUTER_WIDTH = 1600;
const OUTER_HEIGHT = 900;
const OUTER_FONT_SIZE = 14;
const CLAUDE_VISUAL_REDACTION_FILTER =
  'drawbox=x=0:y=0:w=iw:h=180:color=black:t=fill';

const DEMO_TOOL_SPECS = ['vhs@0.11.0', 'ttyd@1.7.7', 'ffmpeg@8.1.1'];

type AgentName = (typeof AGENTS)[number];

export interface HeroDemoOptions {
  agent: AgentName | 'both';
  runs: number;
  promote: boolean;
  bundleDir: string;
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
  claudeEffort: string;
  sentence: string;
  keepDebug: boolean;
  recordSeconds: number;
}

export interface GeneratedTapeInput {
  agent: AgentName;
  runnerPath: string;
  recordSeconds: number;
}

export interface GeneratedRunnerInput {
  agent: AgentName;
  workspace: string;
  promptPath: string;
  installPrefix: string;
  innerHome: string;
  finalFile: string;
  innerCast: string;
  innerWebm: string;
  expectedText: string;
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
  claudeEffort: string;
}

export interface RunRecord {
  agent: AgentName;
  index: number;
  runDir: string;
  passed: boolean;
  selected: boolean;
  outerWebm: string;
  outerTranscript: string;
  outerThumbnail: string;
  prompt: string;
  innerCast: string;
  innerWebm: string;
  finalProof: string;
  finalFile: string;
  error?: string;
}

export interface CuratedArtifact {
  path: string;
  description: string;
  sha256: string;
  bytes: number;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function assertAgent(value: string): asserts value is AgentName | 'both' {
  invariant(
    value === 'both' || AGENTS.includes(value as AgentName),
    `--agent must be one of: both, codex, claude`,
  );
}

export function selectedAgents(agent: AgentName | 'both'): AgentName[] {
  return agent === 'both' ? [...AGENTS] : [agent];
}

export function parseHeroDemoArgs(argv: string[]): HeroDemoOptions {
  let agent: AgentName | 'both' = 'both';
  let runs = 1;
  let promote = false;
  let bundleDir = DEFAULT_BUNDLE_DIR;
  let codexModel = process.env.AGENT_TTY_HERO_CODEX_MODEL ?? 'gpt-5.5';
  let codexEffort = process.env.AGENT_TTY_HERO_CODEX_EFFORT ?? 'low';
  let claudeModel =
    process.env.AGENT_TTY_HERO_CLAUDE_MODEL ?? 'claude-opus-4-7';
  let claudeEffort = process.env.AGENT_TTY_HERO_CLAUDE_EFFORT ?? 'low';
  const sentence = process.env.AGENT_TTY_HERO_SENTENCE ?? DEFAULT_SENTENCE;
  let keepDebug = false;
  let recordSeconds = Number(
    process.env.AGENT_TTY_HERO_RECORD_SECONDS ?? String(DEFAULT_RECORD_SECONDS),
  );

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    invariant(arg !== undefined, 'argument index out of range');
    switch (arg) {
      case '--agent': {
        const value = argv[++index];
        invariant(value !== undefined, '--agent requires a value');
        assertAgent(value);
        agent = value;
        break;
      }
      case '--runs': {
        const value = argv[++index];
        invariant(value !== undefined, '--runs requires a value');
        runs = Number(value);
        break;
      }
      case '--promote':
        promote = true;
        break;
      case '--bundle-dir': {
        const value = argv[++index];
        invariant(value !== undefined, '--bundle-dir requires a value');
        bundleDir = resolve(value);
        break;
      }
      case '--codex-model': {
        const value = argv[++index];
        invariant(value !== undefined, '--codex-model requires a value');
        codexModel = value;
        break;
      }
      case '--codex-effort': {
        const value = argv[++index];
        invariant(value !== undefined, '--codex-effort requires a value');
        codexEffort = value;
        break;
      }
      case '--claude-model': {
        const value = argv[++index];
        invariant(value !== undefined, '--claude-model requires a value');
        claudeModel = value;
        break;
      }
      case '--claude-effort': {
        const value = argv[++index];
        invariant(value !== undefined, '--claude-effort requires a value');
        claudeEffort = value;
        break;
      }
      case '--keep-debug':
        keepDebug = true;
        break;
      case '--record-seconds': {
        const value = argv[++index];
        invariant(value !== undefined, '--record-seconds requires a value');
        recordSeconds = Number(value);
        break;
      }
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  invariant(
    Number.isInteger(runs) && runs > 0,
    '--runs must be a positive integer',
  );
  invariant(
    Number.isInteger(recordSeconds) && recordSeconds > 0,
    '--record-seconds must be a positive integer',
  );
  if (promote) {
    invariant(runs >= 3, '--promote requires --runs >= 3');
    invariant(agent === 'both', '--promote requires --agent both');
  }

  return {
    agent,
    runs,
    promote,
    bundleDir,
    codexModel,
    codexEffort,
    claudeModel,
    claudeEffort,
    sentence,
    keepDebug,
    recordSeconds,
  };
}

function usage(): string {
  return [
    'Usage: npm run demo:agent-uses-agent-tty -- [--agent both|codex|claude] [--runs N] [--record-seconds N] [--codex-model MODEL] [--claude-model MODEL] [--promote]',
    '',
    'Regenerates the real-agent Hero Demo with VHS as the outer camera.',
  ].join('\n');
}

export function generateTape(input: GeneratedTapeInput): string {
  const startupRegex =
    input.agent === 'codex'
      ? 'Do you trust|OpenAI Codex|Codex'
      : 'Quick safety check|Claude Code|Yes, I trust|Welcome';
  const uiRegex =
    input.agent === 'codex'
      ? 'OpenAI Codex|Codex'
      : 'Claude Code|Welcome|esc to interrupt';
  const exitCommand = input.agent === 'codex' ? '/quit' : '/exit';
  return [
    'Output outer.webm',
    'Output outer.ascii',
    'Set Shell bash',
    `Set Width ${String(OUTER_WIDTH)}`,
    `Set Height ${String(OUTER_HEIGHT)}`,
    `Set FontSize ${String(OUTER_FONT_SIZE)}`,
    'Set TypingSpeed 10ms',
    'Set Framerate 5',
    'Set PlaybackSpeed 1.0',
    `Type "bash ${input.runnerPath}"`,
    'Enter',
    `Wait+Screen@120s /${startupRegex}/`,
    'Sleep 1s',
    'Enter',
    `Wait+Screen@120s /${uiRegex}/`,
    `Sleep ${String(input.recordSeconds)}s`,
    'Ctrl+C',
    'Sleep 1s',
    `Type "${exitCommand}"`,
    'Enter',
    'Sleep 5s',
    'Ctrl+C',
    'Sleep 1s',
    '',
  ].join('\n');
}

export function generateRunner(input: GeneratedRunnerInput): string {
  if (input.agent === 'codex') {
    const trustConfig = `projects.${JSON.stringify(input.workspace)}.trust_level="trusted"`;
    return [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `cd ${quote(input.workspace)}`,
      `export PATH=${quote(join(input.installPrefix, 'bin'))}:$PATH`,
      `export AGENT_TTY_HOME=${quote(input.innerHome)}`,
      `export HERO_FINAL_FILE=${quote(input.finalFile)}`,
      `export HERO_INNER_CAST=${quote(input.innerCast)}`,
      `export HERO_INNER_WEBM=${quote(input.innerWebm)}`,
      `export HERO_EXPECTED_TEXT=${quote(input.expectedText)}`,
      `PROMPT="$(cat ${quote(input.promptPath)})"`,
      `CODEX_TRUST_CONFIG=${quote(trustConfig)}`,
      'export CODEX_DISABLE_UPDATE_CHECK=1',
      'exec codex --cd "$PWD" ' +
        `--model ${quote(input.codexModel)} ` +
        '-c "$CODEX_TRUST_CONFIG" ' +
        `-c model_reasoning_effort=${quote(input.codexEffort)} ` +
        '--dangerously-bypass-approvals-and-sandbox "$PROMPT"',
      '',
    ].join('\n');
  }

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `cd ${quote(input.workspace)}`,
    `export PATH=${quote(join(input.installPrefix, 'bin'))}:$PATH`,
    `export AGENT_TTY_HOME=${quote(input.innerHome)}`,
    `export HERO_FINAL_FILE=${quote(input.finalFile)}`,
    `export HERO_INNER_CAST=${quote(input.innerCast)}`,
    `export HERO_INNER_WEBM=${quote(input.innerWebm)}`,
    `export HERO_EXPECTED_TEXT=${quote(input.expectedText)}`,
    `PROMPT="$(cat ${quote(input.promptPath)})"`,
    'unset ANTHROPIC_API_KEY',
    'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'exec claude --permission-mode bypassPermissions --dangerously-skip-permissions ' +
      `--model ${quote(input.claudeModel)} ` +
      `--effort ${quote(input.claudeEffort)} "$PROMPT"`,
    '',
  ].join('\n');
}

export function buildLeakFindings(text: string): string[] {
  const patterns: Array<[RegExp, string]> = [
    [/\/home\/[A-Za-z0-9._-]+/g, 'absolute Linux home path'],
    [/\/Users\/[A-Za-z0-9._-]+/g, 'absolute macOS home path'],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'email address'],
    [/ANTHROPIC_(?:AUTH_TOKEN|API_KEY)/g, 'Anthropic credential variable'],
    [/OPENAI_API_KEY/g, 'OpenAI credential variable'],
    [/API Usage Billing/gi, 'account/billing line'],
    [/Auth conflict/gi, 'auth warning'],
    [/Welcome back [^!\n]+/gi, 'account greeting'],
    [/(?:sk|sess|tok)_[A-Za-z0-9_-]{16,}/g, 'token-like secret'],
  ];
  const findings: string[] = [];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) {
      findings.push(label);
    }
  }
  return [...new Set(findings)];
}
export function sanitizePromotedText(text: string): string {
  return text
    .replaceAll(/\/home\/[A-Za-z0-9._-]+/g, '<home>')
    .replaceAll(/\/Users\/[A-Za-z0-9._-]+/g, '<home>')
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replaceAll(
      /ANTHROPIC_(?:AUTH_TOKEN|API_KEY)/g,
      '<anthropic-credential-var>',
    )
    .replaceAll(/OPENAI_API_KEY/g, '<openai-credential-var>')
    .replaceAll(/.*API Usage Billing.*\n?/gi, '')
    .replaceAll(/.*Auth conflict.*\n?/gi, '')
    .replaceAll(/.*Welcome back [^!\n]+!.*\n?/gi, '')
    .replaceAll(/(?:sk|sess|tok)_[A-Za-z0-9_-]{16,}/g, '<token>');
}

function isTextArtifact(path: string): boolean {
  return (
    path.endsWith('.txt') ||
    path.endsWith('.md') ||
    path.endsWith('.ascii') ||
    path.endsWith('.cast')
  );
}

async function copyPromotedArtifact(
  from: string,
  to: string,
  agent: AgentName,
  relativePath: string,
): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  if (isTextArtifact(relativePath)) {
    await writeFile(to, sanitizePromotedText(await readFile(from, 'utf8')));
    return;
  }
  if (agent === 'claude' && relativePath.endsWith('-outer.webm')) {
    runDemoTool('ffmpeg', [
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      from,
      '-vf',
      CLAUDE_VISUAL_REDACTION_FILTER,
      '-an',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-b:v',
      '0',
      '-crf',
      '34',
      to,
    ]);
    return;
  }
  if (agent === 'claude' && relativePath.endsWith('-thumbnail.png')) {
    runDemoTool('ffmpeg', [
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      from,
      '-vf',
      CLAUDE_VISUAL_REDACTION_FILTER,
      '-frames:v',
      '1',
      to,
    ]);
    return;
  }
  await copyFile(from, to);
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o755 });
}

async function assertNonEmpty(path: string): Promise<void> {
  const stats = await stat(path);
  invariant(
    stats.isFile() && stats.size > 0,
    `expected non-empty file: ${path}`,
  );
}

let cachedDemoToolPathPrefix: string | undefined;

function demoToolPathPrefix(): string {
  cachedDemoToolPathPrefix ??= run('mise', ['bin-paths', ...DEMO_TOOL_SPECS])
    .trim()
    .split('\n')
    .filter(Boolean)
    .join(':');
  invariant(cachedDemoToolPathPrefix !== '', 'demo tool PATH is empty');
  return cachedDemoToolPathPrefix;
}

function demoToolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${demoToolPathPrefix()}:${process.env.PATH ?? ''}`,
  };
}

function runDemoTool(command: string, args: string[], cwd = REPO_ROOT): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: demoToolEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(command: string, args: string[], cwd = REPO_ROOT): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function runLogged(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const logFd = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd,
      env,
      stdio: ['ignore', logFd, logFd],
      timeout: timeoutMs,
    });
  } finally {
    closeSync(logFd);
  }

  const hasRecorderOutputs =
    isNonEmptyFile(join(cwd, 'outer.webm')) &&
    isNonEmptyFile(join(cwd, 'outer.ascii'));
  if (
    (result.error !== undefined || result.status !== 0) &&
    !hasRecorderOutputs
  ) {
    throw new Error(`${command} ${args.join(' ')} failed; see ${logPath}`);
  }
}

function ensureThumbnail(runDir: string): void {
  const thumbnailPath = join(runDir, 'marker.png');
  if (existsSync(thumbnailPath) && isNonEmptyFile(thumbnailPath)) {
    return;
  }
  runDemoTool('ffmpeg', [
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-sseof',
    '-1',
    '-i',
    join(runDir, 'outer.webm'),
    '-frames:v',
    '1',
    thumbnailPath,
  ]);
}

async function installLocalAgentTty(debugRoot: string): Promise<string> {
  run('npm', ['run', 'build']);
  const packJsonPath = join(debugRoot, 'npm-pack.json');
  const packJson = run('npm', ['pack', '--json', '--ignore-scripts']);
  await writeFile(packJsonPath, packJson);
  const parsed = JSON.parse(packJson) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename;
  invariant(filename !== undefined, 'npm pack did not report a filename');
  const tarballPath = join(REPO_ROOT, filename);
  const installPrefix = join(debugRoot, 'install');
  await mkdir(installPrefix, { recursive: true });
  run(
    'npm',
    ['install', '-g', '--prefix', installPrefix, tarballPath],
    REPO_ROOT,
  );
  await rm(tarballPath, { force: true });
  return installPrefix;
}

function renderPrompt(): string {
  return [
    'You are running inside a disposable workspace for an agent-tty Hero Demo.',
    '',
    'Explore the installed agent-tty skill and CLI yourself, then use agent-tty to drive a real Neovim session.',
    'Do not run a prewritten helper script; this run is meant to show how a coding agent uses agent-tty in the wild.',
    '',
    'Success criteria:',
    '- Learn the available workflow from the packaged agent-tty skill and CLI help as needed.',
    '- Use the agent-tty binary on PATH and the already configured AGENT_TTY_HOME.',
    '- Create an agent-tty session that launches nvim --clean -n demo-note.txt.',
    '- Interact with Neovim through agent-tty and write exactly the text in HERO_EXPECTED_TEXT.',
    '- Ensure the final file path in HERO_FINAL_FILE contains that exact text.',
    '- Export the inner agent-tty recording to HERO_INNER_CAST and HERO_INNER_WEBM.',
    '- Destroy the agent-tty session after exporting the proof artifacts.',
    '- The recorder stops after a fixed review window, so complete the proof artifacts promptly and then summarize what you did.',
    '',
    'Use the HERO_* environment variables for all required paths and final text. Avoid changing files outside this disposable workspace.',
    '',
  ].join('\n');
}

async function waitForProofFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          const stats = await stat(path);
          return stats.isFile() && stats.size > 0;
        } catch {
          return false;
        }
      }),
    );
    if (results.every(Boolean)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`timed out waiting for proof files: ${paths.join(', ')}`);
}

async function runOne(
  agent: AgentName,
  index: number,
  options: HeroDemoOptions,
  debugRoot: string,
  installPrefix: string,
): Promise<RunRecord> {
  const runDir = join(debugRoot, `${agent}-${String(index)}`);
  const workspace = join(runDir, 'workspace');
  const innerHome = join(runDir, 'inner-home');
  const workspaceArtifacts = join(workspace, 'artifacts');
  const finalFile = join(workspace, 'demo-note.txt');
  const innerCast = join(workspaceArtifacts, 'inner-nvim.cast');
  const innerWebm = join(workspaceArtifacts, 'inner-nvim.webm');
  const promptPath = join(runDir, `${agent}-prompt.md`);
  const runnerPath = join(runDir, `run-${agent}.sh`);
  const tapePath = join(runDir, 'record.tape');

  await mkdir(workspaceArtifacts, { recursive: true });
  run('git', ['init', '-q'], workspace);
  await writeFile(
    join(workspace, 'README.md'),
    '# agent-tty Hero Demo workspace\n',
  );
  const prompt = renderPrompt();
  await writeFile(promptPath, prompt);
  await writeExecutable(
    runnerPath,
    generateRunner({
      agent,
      workspace,
      promptPath,
      installPrefix,
      innerHome,
      finalFile,
      innerCast,
      innerWebm,
      expectedText: options.sentence,
      codexModel: options.codexModel,
      codexEffort: options.codexEffort,
      claudeModel: options.claudeModel,
      claudeEffort: options.claudeEffort,
    }),
  );
  await writeFile(
    tapePath,
    generateTape({ agent, runnerPath, recordSeconds: options.recordSeconds }),
  );

  const vhsLog = join(runDir, 'vhs.log');
  runLogged(
    'vhs',
    [basename(tapePath)],
    runDir,
    vhsLog,
    (options.recordSeconds + 180) * 1000,
    demoToolEnv(),
  );
  ensureThumbnail(runDir);

  await assertNonEmpty(join(runDir, 'outer.webm'));
  await assertNonEmpty(join(runDir, 'outer.ascii'));
  await assertNonEmpty(join(runDir, 'marker.png'));
  await waitForProofFiles([innerCast, innerWebm, finalFile]);
  await assertNonEmpty(innerCast);
  await assertNonEmpty(innerWebm);
  await assertNonEmpty(finalFile);
  const transcript = await readFile(join(runDir, 'outer.ascii'), 'utf8');
  const tuiMarker = agent === 'codex' ? 'OpenAI Codex' : 'Claude Code';
  invariant(
    transcript.includes(tuiMarker),
    `outer transcript did not show ${tuiMarker}`,
  );
  const final = (await readFile(finalFile, 'utf8')).trimEnd();
  invariant(
    final === options.sentence,
    'final file did not match expected sentence',
  );

  const proofPath = join(runDir, 'final-file-proof.txt');
  await writeFile(
    proofPath,
    [
      `agent=${agent}`,
      `expected=${options.sentence}`,
      `actual=${final}`,
      `sha256=${sha256Text(final)}`,
      '',
    ].join('\n'),
  );

  return {
    agent,
    index,
    runDir,
    passed: true,
    selected: false,
    outerWebm: join(runDir, 'outer.webm'),
    outerTranscript: join(runDir, 'outer.ascii'),
    outerThumbnail: join(runDir, 'marker.png'),
    prompt: promptPath,
    innerCast,
    innerWebm,
    finalProof: proofPath,
    finalFile,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedRunRecord(
  agent: AgentName,
  index: number,
  runDir: string,
  error: unknown,
  debugRoot: string,
): RunRecord {
  const message = errorMessage(error)
    .replaceAll(runDir, '<run-dir>')
    .replaceAll(debugRoot, '<debug-root>');
  return {
    agent,
    index,
    runDir,
    passed: false,
    selected: false,
    outerWebm: join(runDir, 'outer.webm'),
    outerTranscript: join(runDir, 'outer.ascii'),
    outerThumbnail: join(runDir, 'marker.png'),
    prompt: join(runDir, `${agent}-prompt.md`),
    innerCast: join(runDir, 'workspace/artifacts/inner-nvim.cast'),
    innerWebm: join(runDir, 'workspace/artifacts/inner-nvim.webm'),
    finalProof: join(runDir, 'final-file-proof.txt'),
    finalFile: join(runDir, 'workspace/demo-note.txt'),
    error: message,
  };
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function artifactEntry(
  bundleDir: string,
  relativePath: string,
  description: string,
): Promise<CuratedArtifact> {
  const fullPath = join(bundleDir, relativePath);
  const stats = await stat(fullPath);
  return {
    path: relativePath,
    description,
    sha256: await sha256File(fullPath),
    bytes: stats.size,
  };
}

async function cleanBundle(bundleDir: string): Promise<void> {
  const keep = new Set(['.gitignore']);
  for (const entry of await readdir(bundleDir, { withFileTypes: true })) {
    if (keep.has(entry.name)) {
      continue;
    }
    await rm(join(bundleDir, entry.name), { recursive: true, force: true });
  }
  await mkdir(join(bundleDir, 'artifacts'), { recursive: true });
}

async function promote(
  options: HeroDemoOptions,
  records: RunRecord[],
): Promise<void> {
  const byAgent = new Map<AgentName, RunRecord[]>();
  for (const agent of AGENTS) {
    byAgent.set(
      agent,
      records.filter((record) => record.agent === agent && record.passed),
    );
  }
  for (const agent of AGENTS) {
    const count = byAgent.get(agent)?.length ?? 0;
    invariant(
      count >= 3,
      `${agent} only had ${String(count)} successful run(s)`,
    );
  }

  const selected = AGENTS.map((agent) => {
    const run = byAgent.get(agent)?.[0];
    invariant(run !== undefined, `no selected run for ${agent}`);
    run.selected = true;
    return run;
  });

  await cleanBundle(options.bundleDir);
  const artifactsDir = join(options.bundleDir, 'artifacts');
  const promotedPaths: Array<{ path: string; description: string }> = [];

  for (const record of selected) {
    const prefix = record.agent;
    const copies: Array<[string, string, string]> = [
      [
        record.outerWebm,
        `artifacts/${prefix}-outer.webm`,
        `Outer VHS WebM recording for ${prefix}`,
      ],
      [
        record.outerThumbnail,
        `artifacts/${prefix}-thumbnail.png`,
        `Outer VHS thumbnail for ${prefix}`,
      ],
      [
        record.outerTranscript,
        `artifacts/${prefix}-outer-transcript.txt`,
        `Outer transcript for ${prefix}`,
      ],
      [
        record.prompt,
        `artifacts/${prefix}-prompt.md`,
        `Prompt used for ${prefix}`,
      ],
      [
        record.innerCast,
        `artifacts/${prefix}-inner-nvim.cast`,
        `Inner agent-tty asciicast for ${prefix}`,
      ],
      [
        record.innerWebm,
        `artifacts/${prefix}-inner-nvim.webm`,
        `Inner agent-tty WebM for ${prefix}`,
      ],
      [
        record.finalProof,
        `artifacts/${prefix}-final-file-proof.txt`,
        `Final file proof for ${prefix}`,
      ],
      [
        record.finalFile,
        `artifacts/${prefix}-demo-note.txt`,
        `Demo note written by ${prefix}`,
      ],
    ];
    for (const [from, relative, description] of copies) {
      const to = join(options.bundleDir, relative);
      await copyPromotedArtifact(from, to, record.agent, relative);
      promotedPaths.push({ path: relative, description });
    }
  }

  const summary = renderSummary(options, records);
  await writeFile(join(options.bundleDir, 'promoted-run-summary.md'), summary);
  promotedPaths.push({
    path: 'promoted-run-summary.md',
    description:
      'Promotion summary proving three successful Codex and Claude runs',
  });

  const readme = renderReadme();
  await writeFile(join(options.bundleDir, 'README.md'), readme);
  promotedPaths.push({
    path: 'README.md',
    description: 'Hero Demo bundle README',
  });

  const reproducePath = join(options.bundleDir, 'reproduce.sh');
  await writeExecutable(reproducePath, renderReproduce(options));
  promotedPaths.push({
    path: 'reproduce.sh',
    description: 'Maintainer-facing reproduction wrapper for the Hero Demo',
  });

  await writeFile(join(options.bundleDir, '.gitignore'), '.debug/\n');

  const manifestArtifacts = [];
  for (const promoted of promotedPaths) {
    manifestArtifacts.push(
      await artifactEntry(
        options.bundleDir,
        promoted.path,
        promoted.description,
      ),
    );
  }
  const manifest = {
    bundle: 'agent-uses-agent-tty',
    title: 'Agents use agent-tty: Codex and Claude Hero Demo',
    description:
      'README-facing Hero Demo where VHS records real Codex and Claude TUIs while agent-tty produces inner proof artifacts.',
    createdAt: new Date().toISOString(),
    scenario: 'agent-uses-agent-tty-hero-demo',
    result: 'pass',
    commands: [
      `mise run demo:agent-uses-agent-tty -- --agent both --runs 3 --record-seconds ${String(options.recordSeconds)} --promote`,
    ],
    artifacts: manifestArtifacts,
  };
  await writeFile(
    join(options.bundleDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const leakTexts = await Promise.all(
    promotedPaths
      .filter(
        (artifact) =>
          !artifact.path.endsWith('.png') && !artifact.path.endsWith('.webm'),
      )
      .map(async (artifact) =>
        readFile(join(options.bundleDir, artifact.path), 'utf8'),
      ),
  );
  const findings = buildLeakFindings(leakTexts.join('\n'));
  invariant(findings.length === 0, `leak check failed: ${findings.join(', ')}`);
  await writeFile(join(artifactsDir, '.gitkeep'), '\n');
}

function safeToolVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    return 'unavailable';
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  return output.split('\n')[0] ?? 'unavailable';
}

function safeDemoToolVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: demoToolEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    return 'unavailable';
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  return output.split('\n')[0] ?? 'unavailable';
}

function collectToolVersions(): Array<[string, string]> {
  return [
    ['vhs', safeDemoToolVersion('vhs', ['--version'])],
    ['ttyd', safeDemoToolVersion('ttyd', ['--version'])],
    ['ffmpeg', safeDemoToolVersion('ffmpeg', ['-version'])],
    ['codex', safeToolVersion('codex', ['--version'])],
    ['claude', safeToolVersion('claude', ['--version'])],
  ];
}

function renderSummary(options: HeroDemoOptions, records: RunRecord[]): string {
  const lines = [
    '# Promoted Hero Demo Run Summary',
    '',
    `generatedAt: ${new Date().toISOString()}`,
    'debugRoot: <debug-only>',
    `codexModel: ${options.codexModel}`,
    `codexEffort: ${options.codexEffort}`,
    `claudeModel: ${options.claudeModel}`,
    `claudeEffort: ${options.claudeEffort}`,
    `recordSeconds: ${String(options.recordSeconds)}`,
    `outerFrame: ${String(OUTER_WIDTH)}x${String(OUTER_HEIGHT)}`,
    `outerFontSize: ${String(OUTER_FONT_SIZE)}`,
    '',
    '## Tool Versions',
    '',
    ...collectToolVersions().map(([tool, version]) => `- ${tool}: ${version}`),
    '',
    '## Runs',
    '',
  ];
  for (const record of records) {
    const status = record.passed
      ? 'pass'
      : `fail - ${record.error ?? 'unknown error'}`;
    lines.push(
      `- ${record.agent} run ${String(record.index)}: ${status}${record.selected ? ' (selected)' : ''}`,
    );
  }
  lines.push(
    '',
    'Manual visual review required before merging promoted artifacts.',
    '',
  );
  return lines.join('\n');
}

function renderReadme(): string {
  return `# Agent Uses agent-tty Hero Demo

This bundle is the README-facing **Hero Demo** for real coding-agent TUIs using \`agent-tty\`.
VHS records the outer Codex and Claude Code TUIs as the presentation layer. The product proof is the inner \`agent-tty\` artifact set produced while each real agent explores the skill and CLI, drives Neovim, and exports recordings.

| Agent | Outer Hero Demo | Inner proof artifacts | File proof |
| --- | --- | --- | --- |
| Codex | [![Codex Hero Demo](./artifacts/codex-thumbnail.png)](./artifacts/codex-outer.webm) | [cast](./artifacts/codex-inner-nvim.cast), [WebM](./artifacts/codex-inner-nvim.webm) | [proof](./artifacts/codex-final-file-proof.txt) |
| Claude | [![Claude Hero Demo](./artifacts/claude-thumbnail.png)](./artifacts/claude-outer.webm) | [cast](./artifacts/claude-inner-nvim.cast), [WebM](./artifacts/claude-inner-nvim.webm) | [proof](./artifacts/claude-final-file-proof.txt) |

See [promoted-run-summary.md](./promoted-run-summary.md) for the regeneration summary.
`;
}

function renderReproduce(options: HeroDemoOptions): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"',
    'cd "$REPO_ROOT"',
    `exec mise run demo:agent-uses-agent-tty -- --agent both --runs 3 --record-seconds ${String(options.recordSeconds)} --promote "$@"`,
    '',
  ].join('\n');
}

export async function runHeroDemo(options: HeroDemoOptions): Promise<void> {
  const debugRoot = resolve(
    await mkDebugRoot(options.bundleDir, `hero-demo-${Date.now().toString()}`),
  );
  const installPrefix = await installLocalAgentTty(debugRoot);
  const records: RunRecord[] = [];
  for (const agent of selectedAgents(options.agent)) {
    let successes = 0;
    const maxAttempts = options.promote ? options.runs * 2 : options.runs;
    for (let index = 1; index <= maxAttempts; index += 1) {
      if (options.promote && successes >= options.runs) {
        break;
      }
      try {
        const record = await runOne(
          agent,
          index,
          options,
          debugRoot,
          installPrefix,
        );
        records.push(record);
        successes += 1;
      } catch (error) {
        const runDir = join(debugRoot, `${agent}-${String(index)}`);
        records.push(failedRunRecord(agent, index, runDir, error, debugRoot));
        if (!options.promote) {
          throw error;
        }
      }
    }
  }
  if (options.promote) {
    await promote(options, records);
  }
  if (!options.keepDebug && options.promote) {
    await rm(debugRoot, { recursive: true, force: true });
  }
}

async function mkDebugRoot(_bundleDir: string, name: string): Promise<string> {
  const root = join(tmpdir(), 'agent-tty-hero-demo', name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

if (isDirectExecution(import.meta.url)) {
  try {
    await runHeroDemo(parseHeroDemoArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = message.startsWith('Usage:') ? 0 : 1;
  }
}
