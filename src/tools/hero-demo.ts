import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  statSync,
} from 'node:fs';
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

import { CanonicalBundleManifestSchema } from './bundleManifestSchema.js';
import { canonicalBundleArtifactEntry } from './canonicalBundleArtifacts.js';
import { invariant } from '../util/assert.js';
import { isDirectExecution } from '../util/isDirectExecution.js';
import { LIBGHOSTTY_VT_PACKAGE } from '../renderer/readiness.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BUNDLE_DIR = join(REPO_ROOT, 'dogfood/agent-uses-agent-tty');
const VIDEO_PLAYBACK_DOC = 'VIDEO_PLAYBACK.md';
const DEFAULT_EXPECTED_TEXT =
  'agent-tty nested Neovim proof from a real coding agent.';
const DEFAULT_RECORD_SECONDS = 3 * 60;
const RECORD_TIMEOUT_BUFFER_SECONDS = 3 * 60;
const AGENTS = ['codex', 'claude'] as const;
// Each run is mostly an idle review-window sleep, so overlapping runs is a big
// wall-clock win. Default to 2 so the two agents record concurrently without
// ever running two sessions of the *same* agent (same account) at once; bump
// --concurrency higher to also overlap an agent's own attempts (costs more CPU
// — each run drives its own headless browser + ffmpeg — and shared-account load).
const DEFAULT_CONCURRENCY = 2;

// 1920 wide to match the README hero's canvas; 900 tall + 14pt keeps the
// content-heavy coding-agent TUI roomy (it gets the larger ~60% pane).
const OUTER_WIDTH = 1920;
const OUTER_HEIGHT = 900;
const OUTER_FONT_SIZE = 14;
// The recording is a tmux split: LEFT = the coding agent, RIGHT = the live
// `agent-tty dashboard`. `-l` sizes the new (right/dashboard) pane, so a smaller
// percentage leaves the larger half for the agent — it is the star of the demo.
const DASHBOARD_PANE_PERCENT = 40;
const CLAUDE_VISUAL_REDACTION_HEIGHT = Math.floor(OUTER_HEIGHT / 5);
// Redact only the LEFT (Claude) pane's header — Claude shows account info up
// top, but the dashboard lives in the right ~DASHBOARD_PANE_PERCENT% of the
// frame and must stay visible (a full-width box would black out its title bar).
const CLAUDE_VISUAL_REDACTION_WIDTH = Math.floor(
  (OUTER_WIDTH * (100 - DASHBOARD_PANE_PERCENT)) / 100,
);
const CLAUDE_VISUAL_REDACTION_FILTER = `drawbox=x=0:y=0:w=${String(CLAUDE_VISUAL_REDACTION_WIDTH)}:h=${String(CLAUDE_VISUAL_REDACTION_HEIGHT)}:color=black:t=fill`;

type AgentName = (typeof AGENTS)[number];

export interface HeroDemoOptions {
  agent: AgentName | 'both';
  runs: number;
  promote: boolean;
  concurrency: number;
  bundleDir: string;
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
  claudeEffort: string;
  expectedText: string;
  keepDebug: boolean;
  recordSeconds: number;
}

export interface GeneratedTapeInput {
  agent: AgentName;
  runnerPath: string;
  dashboardRunnerPath: string;
  socket: string;
  recordSeconds: number;
}

export interface GeneratedDashboardRunnerInput {
  installPrefix: string;
  innerHome: string;
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

export interface PromotionRunInput {
  agent: AgentName;
  index: number;
  passed: boolean;
}

export interface PromotionSelection {
  agent: AgentName;
  index: number;
}

interface RunRecord {
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

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertAgent(value: string): asserts value is AgentName | 'both' {
  invariant(
    value === 'both' || AGENTS.includes(value as AgentName),
    `--agent must be one of: both, codex, claude`,
  );
}

/** Selects the concrete coding-agent CLIs to exercise for a parsed demo request. */
export function selectedAgents(agent: AgentName | 'both'): AgentName[] {
  return agent === 'both' ? [...AGENTS] : [agent];
}

/**
 * Runs `worker` over `items` with at most `limit` in flight at once, returning
 * results in input order. Hero Demo runs are dominated by an idle review-window
 * sleep, so overlapping them is a large wall-clock win; the cap keeps fan-out
 * bounded (each run drives its own headless browser + ffmpeg).
 */
export async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      invariant(item !== undefined, 'worker item index out of range');
      results[index] = await worker(item, index);
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  return results;
}

/** Parses maintainer-facing Hero Demo generator arguments and environment defaults. */
export function parseHeroDemoArgs(argv: string[]): HeroDemoOptions {
  let agent: AgentName | 'both' = 'both';
  // Default to the full promote regeneration so `mise run demo:agent-uses-agent-tty`
  // (no flags) just rebuilds the bundle. Pass --no-promote for a quick test run.
  let runs = 3;
  let promote = true;
  let bundleDir = DEFAULT_BUNDLE_DIR;
  let codexModel = process.env.AGENT_TTY_HERO_CODEX_MODEL ?? 'gpt-5.5';
  let codexEffort = process.env.AGENT_TTY_HERO_CODEX_EFFORT ?? 'low';
  let claudeModel =
    process.env.AGENT_TTY_HERO_CLAUDE_MODEL ?? 'claude-opus-4-7';
  let claudeEffort = process.env.AGENT_TTY_HERO_CLAUDE_EFFORT ?? 'low';
  const expectedText =
    process.env.AGENT_TTY_HERO_SENTENCE ?? DEFAULT_EXPECTED_TEXT;
  let keepDebug = false;
  let recordSeconds = Number(
    process.env.AGENT_TTY_HERO_RECORD_SECONDS ?? String(DEFAULT_RECORD_SECONDS),
  );
  let concurrency = Number(
    process.env.AGENT_TTY_HERO_CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
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
      case '--no-promote':
        promote = false;
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
      case '--concurrency': {
        const value = argv[++index];
        invariant(value !== undefined, '--concurrency requires a value');
        concurrency = Number(value);
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
  invariant(
    Number.isInteger(concurrency) && concurrency > 0,
    '--concurrency must be a positive integer',
  );
  if (promote) {
    invariant(
      runs >= 3,
      '--promote requires --runs >= 3 (pass --no-promote for a quick test run)',
    );
    invariant(
      agent === 'both',
      '--promote requires --agent both (pass --no-promote to test a single agent)',
    );
  }

  return {
    agent,
    runs,
    promote,
    concurrency,
    bundleDir,
    codexModel,
    codexEffort,
    claudeModel,
    claudeEffort,
    expectedText,
    keepDebug,
    recordSeconds,
  };
}

function usage(): string {
  return [
    'Usage: mise run demo:agent-uses-agent-tty -- [--no-promote] [--agent both|codex|claude] [--runs N] [--record-seconds N] [--concurrency N] [--bundle-dir DIR] [--codex-model MODEL] [--codex-effort LEVEL] [--claude-model MODEL] [--claude-effort LEVEL] [--keep-debug]',
    '',
    'Regenerates the real-agent Hero Demo with VHS as the outer camera.',
    'Defaults to a full promote run (--agent both --runs 3 --record-seconds 180).',
    'Runs record concurrently (--concurrency, default 2): each run is mostly an',
    'idle review-window sleep, so overlapping them is a large wall-clock win.',
    "Higher concurrency also overlaps an agent's own attempts but costs more CPU",
    '(each run drives its own headless browser + ffmpeg) and shared-account load.',
    'Pass --no-promote (optionally with --runs 1 --agent codex) for a quick test',
    'run that records into the debug dir without touching the bundle.',
  ].join('\n');
}

/** Builds the VHS outer-camera tape for one real coding-agent run. */
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
  // `-f /dev/null` ignores any host ~/.tmux.conf (so pane 0-indexing and defaults
  // hold); `-L <socket>` isolates this run's server so it can be reaped cleanly.
  const tmuxNew = `tmux -f /dev/null -L ${input.socket}`;
  // One hidden tmux command builds the whole split: pane 0 (LEFT) runs the agent
  // directly, pane 1 (RIGHT) runs the dashboard; `split-window -d` keeps the
  // agent pane focused, `set -g status off` drops the status bar, then `attach`.
  // The recording opens directly on a clean two-pane split — like the README
  // hero — instead of showing tmux plumbing or an `exec bash <runner>` line. The
  // dashboard runner exports the same AGENT_TTY_HOME, so it auto-follows the
  // agent's newest session.
  const splitSetup =
    `${tmuxNew} new-session -d -s hero 'bash ${input.runnerPath}'` +
    ` \\; set -g status off` +
    ` \\; split-window -h -d -l ${String(DASHBOARD_PANE_PERCENT)}% -t hero 'bash ${input.dashboardRunnerPath}'` +
    ` \\; attach -t hero`;
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
    // Build the split off-camera so the recording opens on it, not on tmux setup.
    'Hide',
    `Type "${splitSetup}"`,
    'Enter',
    'Sleep 2s',
    'Show',
    // Now visible: the agent boots in the LEFT pane (trust prompt → accept →
    // UI), then works for the review window while the dashboard mirrors it.
    `Wait+Screen@120s /${startupRegex}/`,
    'Sleep 1s',
    'Enter',
    `Wait+Screen@120s /${uiRegex}/`,
    `Sleep ${String(input.recordSeconds)}s`,
    // Hidden teardown: exit the agent. Stays hidden so the GIF ends on the
    // agent + dashboard, not on the bare shell the exit collapses tmux back to
    // (the run's tmux server is reaped by killTmuxServer after VHS returns).
    'Hide',
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

/** Builds the shell runner for the RIGHT pane: the live `agent-tty dashboard`. */
export function generateDashboardRunner(
  input: GeneratedDashboardRunnerInput,
): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export PATH=${quote(join(input.installPrefix, 'bin'))}:$PATH`,
    // Same AGENT_TTY_HOME as the agent runner so the dashboard sees its sessions.
    `export AGENT_TTY_HOME=${quote(input.innerHome)}`,
    // --all keeps a session visible through its terminal state; the dashboard
    // auto-selects the newest session, so it follows the agent without input.
    'exec agent-tty dashboard --all',
    '',
  ].join('\n');
}

/** Builds the shell runner that launches the requested coding-agent CLI. */
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

/** Finds account-sensitive text patterns that must not appear in promoted artifacts. */
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
/** Scrubs account-sensitive text from copied text artifacts before promotion. */
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
    .replaceAll(/.*Welcome back [^\n]*\n?/gi, '')
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

function runDemoTool(command: string, args: string[], cwd = REPO_ROOT): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
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

/** Tears down a run's isolated tmux server; ignores an already-gone server. */
function killTmuxServer(socket: string): void {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
}

/**
 * Fail fast if the installed agent-tty cannot render the dashboard. The
 * dashboard requires the optional native renderer; when it is absent the
 * RIGHT pane's `agent-tty dashboard` exits at startup and its tmux pane
 * closes, leaving a single-pane recording that would otherwise pass every
 * downstream check. Confirm the capability before spending a recording on it.
 */
function assertDashboardRendererInstalled(installPrefix: string): void {
  const binary = join(installPrefix, 'bin', 'agent-tty');
  // `doctor` exits non-zero when any check fails (e.g. Playwright), so we read
  // stdout regardless of exit code and inspect only the dashboard capability.
  const result = spawnSync(binary, ['doctor', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dashboard: { status?: string } | undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      result?: { capabilities?: Array<{ name: string; status: string }> };
    };
    dashboard = parsed.result?.capabilities?.find(
      (capability) => capability.name === 'dashboard',
    );
  } catch {
    throw new Error(
      'agent-tty doctor --json did not return parseable JSON; cannot confirm the dashboard renderer',
    );
  }
  invariant(
    dashboard?.status === 'available',
    `the installed agent-tty dashboard renderer is unavailable (${LIBGHOSTTY_VT_PACKAGE}); the RIGHT recording pane would be blank. Reinstall agent-tty on a supported platform so the optional native package is fetched.`,
  );
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
  const failed = result.error !== undefined || result.status !== 0;
  if (failed && !hasRecorderOutputs) {
    throw new Error(`${command} ${args.join(' ')} failed; see ${logPath}`);
  }
  if (failed) {
    const reason = result.error?.message ?? `status ${String(result.status)}`;
    appendFileSync(
      logPath,
      `\nWARNING: ${command} ${args.join(' ')} failed (${reason}); continuing because recorder outputs exist.\n`,
    );
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

async function missingFiles(paths: string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (path) => {
      try {
        const stats = await stat(path);
        return stats.isFile() && stats.size > 0 ? undefined : path;
      } catch {
        return path;
      }
    }),
  );
  return checks.filter((path): path is string => path !== undefined);
}

async function waitForProofFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if ((await missingFiles(paths)).length === 0) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  const missing = await missingFiles(paths);
  throw new Error(`timed out waiting for proof files: ${missing.join(', ')}`);
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
  const dashboardRunnerPath = join(runDir, `run-${agent}-dashboard.sh`);
  const tapePath = join(runDir, 'record.tape');
  // basename(debugRoot) carries a per-process timestamp, so concurrent demo
  // invocations get distinct sockets and one run's teardown never reaps another.
  const tmuxSocket = `hero-${agent}-${String(index)}-${basename(debugRoot)}`;

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
      expectedText: options.expectedText,
      codexModel: options.codexModel,
      codexEffort: options.codexEffort,
      claudeModel: options.claudeModel,
      claudeEffort: options.claudeEffort,
    }),
  );
  await writeExecutable(
    dashboardRunnerPath,
    generateDashboardRunner({ installPrefix, innerHome }),
  );
  await writeFile(
    tapePath,
    generateTape({
      agent,
      runnerPath,
      dashboardRunnerPath,
      socket: tmuxSocket,
      recordSeconds: options.recordSeconds,
    }),
  );

  const vhsLog = join(runDir, 'vhs.log');
  try {
    runLogged(
      'vhs',
      [basename(tapePath)],
      runDir,
      vhsLog,
      (options.recordSeconds + RECORD_TIMEOUT_BUFFER_SECONDS) * 1000,
    );
  } finally {
    // Reap this run's isolated tmux server (best-effort: it may already be gone
    // when the agent and dashboard panes exited at teardown).
    killTmuxServer(tmuxSocket);
  }
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
  // The whole point of the split is the live dashboard on the RIGHT. Its list
  // header ("Sessions · <scope>") is dashboard-only chrome the agent TUI never
  // prints, so its absence means the dashboard pane died — fail rather than
  // promote a single-pane recording.
  invariant(
    transcript.includes('Sessions ·'),
    'outer transcript did not show the dashboard pane (no "Sessions ·" header); the RIGHT pane likely failed to render',
  );
  const final = (await readFile(finalFile, 'utf8')).trimEnd();
  invariant(
    final === options.expectedText,
    `final file did not match expected text: expected=${JSON.stringify(options.expectedText)} actual=${JSON.stringify(final)}`,
  );

  const proofPath = join(runDir, 'final-file-proof.txt');
  await writeFile(
    proofPath,
    [
      `agent=${agent}`,
      `expected=${options.expectedText}`,
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

async function cleanBundle(bundleDir: string): Promise<void> {
  const keep = new Set(['.gitignore', VIDEO_PLAYBACK_DOC]);
  for (const entry of await readdir(bundleDir, { withFileTypes: true })) {
    if (keep.has(entry.name)) {
      continue;
    }
    await rm(join(bundleDir, entry.name), { recursive: true, force: true });
  }
  await mkdir(join(bundleDir, 'artifacts'), { recursive: true });
}

/** Selects the first passing run per agent after enforcing the promotion bar. */
export function selectPromotionRuns(
  records: PromotionRunInput[],
): PromotionSelection[] {
  return AGENTS.map((agent) => {
    const passing = records.filter(
      (record) => record.agent === agent && record.passed,
    );
    invariant(
      passing.length >= 3,
      `${agent} only had ${String(passing.length)} successful run(s)`,
    );
    const selected = passing[0];
    invariant(selected !== undefined, `no selected run for ${agent}`);
    return { agent, index: selected.index };
  });
}

async function promote(
  options: HeroDemoOptions,
  records: RunRecord[],
): Promise<void> {
  const selected = selectPromotionRuns(records).map((selection) => {
    const run = records.find(
      (record) =>
        record.agent === selection.agent && record.index === selection.index,
    );
    invariant(
      run !== undefined && run.passed,
      `selected run missing for ${selection.agent} ${String(selection.index)}`,
    );
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
  promotedPaths.push({
    path: VIDEO_PLAYBACK_DOC,
    description: 'GitHub video playback guidance for the Hero Demo',
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
      await canonicalBundleArtifactEntry(
        options.bundleDir,
        promoted.path,
        promoted.description,
      ),
    );
  }
  const manifest = CanonicalBundleManifestSchema.parse({
    bundle: 'agent-uses-agent-tty',
    title: 'Agents use agent-tty: Codex and Claude Hero Demo',
    description:
      'README-facing Hero Demo where VHS records real Codex and Claude TUIs while agent-tty produces inner proof artifacts.',
    createdAt: new Date().toISOString(),
    scenario: 'agent-uses-agent-tty-hero-demo',
    result: 'pass',
    commands: [
      `mise run demo:agent-uses-agent-tty -- --record-seconds ${String(options.recordSeconds)}`,
    ],
    artifacts: manifestArtifacts,
  });
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

function safeToolVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
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
    ['vhs', safeToolVersion('vhs', ['--version'])],
    ['tmux', safeToolVersion('tmux', ['-V'])],
    ['ttyd', safeToolVersion('ttyd', ['--version'])],
    ['ffmpeg', safeToolVersion('ffmpeg', ['-version'])],
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

GitHub may show checked-in WebM files as raw downloads; see [${VIDEO_PLAYBACK_DOC}](./${VIDEO_PLAYBACK_DOC}) for the H.264 attachment flow used to turn these thumbnails into GitHub video-player links.

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
    `exec mise run demo:agent-uses-agent-tty -- --record-seconds ${String(options.recordSeconds)} "$@"`,
    '',
  ].join('\n');
}

/** Records one run, capturing failures as a record instead of throwing. */
async function runOneSafe(
  agent: AgentName,
  index: number,
  options: HeroDemoOptions,
  debugRoot: string,
  installPrefix: string,
): Promise<RunRecord> {
  try {
    return await runOne(agent, index, options, debugRoot, installPrefix);
  } catch (error) {
    const runDir = join(debugRoot, `${agent}-${String(index)}`);
    return failedRunRecord(agent, index, runDir, error, debugRoot);
  }
}

/** Runs the live-agent Hero Demo workflow and optionally promotes passing artifacts. */
export async function runHeroDemo(options: HeroDemoOptions): Promise<void> {
  const debugRoot = resolve(
    await mkDebugRoot(`hero-demo-${Date.now().toString()}`),
  );
  if (!options.promote || options.keepDebug) {
    process.stderr.write(`debugRoot: ${debugRoot}\n`);
  }
  const installPrefix = await installLocalAgentTty(debugRoot);
  assertDashboardRendererInstalled(installPrefix);
  const agents = selectedAgents(options.agent);
  const records: RunRecord[] = [];

  // Wave 1: the first `runs` attempts per agent, interleaved across agents so a
  // pool of size N pairs distinct agents before doubling up on one — the default
  // --concurrency 2 stays at one Codex + one Claude, never two of the same
  // account at once. Runs overlap freely because each is mostly an idle sleep.
  const firstWave: Array<{ agent: AgentName; index: number }> = [];
  for (let index = 1; index <= options.runs; index += 1) {
    for (const agent of agents) {
      firstWave.push({ agent, index });
    }
  }
  records.push(
    ...(await mapWithConcurrency(firstWave, options.concurrency, (task) =>
      runOneSafe(task.agent, task.index, options, debugRoot, installPrefix),
    )),
  );

  if (!options.promote) {
    // Quick-test parity with the old sequential path: surface the first failure.
    const failure = records.find((record) => !record.passed);
    if (failure) {
      throw new Error(failure.error ?? `${failure.agent} run failed`);
    }
    return;
  }

  // Top-up: any agent short of `runs` successes gets one more attempt per round
  // (rounds run across agents in parallel), capped at runs*2 total attempts —
  // the same adaptive retry budget as before, just batched. Same-agent retries
  // stay serial across rounds so we never pile concurrent sessions on one account.
  const attemptsByAgent = new Map<AgentName, number>(
    agents.map((agent) => [agent, options.runs]),
  );
  const maxAttempts = options.runs * 2;
  for (;;) {
    const topUp: Array<{ agent: AgentName; index: number }> = [];
    for (const agent of agents) {
      const successes = records.filter(
        (record) => record.agent === agent && record.passed,
      ).length;
      const attempts = attemptsByAgent.get(agent) ?? options.runs;
      if (successes < options.runs && attempts < maxAttempts) {
        const nextIndex = attempts + 1;
        attemptsByAgent.set(agent, nextIndex);
        topUp.push({ agent, index: nextIndex });
      }
    }
    if (topUp.length === 0) {
      break;
    }
    records.push(
      ...(await mapWithConcurrency(topUp, options.concurrency, (task) =>
        runOneSafe(task.agent, task.index, options, debugRoot, installPrefix),
      )),
    );
  }

  await promote(options, records);
  if (!options.keepDebug) {
    await rm(debugRoot, { recursive: true, force: true });
  }
}

async function mkDebugRoot(name: string): Promise<string> {
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
