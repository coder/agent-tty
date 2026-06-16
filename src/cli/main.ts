#!/usr/bin/env node

import process from 'node:process';

import { Command, CommanderError } from 'commander';

import type { CommandContext } from './context.js';

import { runBatchCommand } from './commands/batch.js';
import { runCreateCommand } from './commands/create.js';
import { runDashboardCommand } from './commands/dashboard.js';
import { runDestroyCommand } from './commands/destroy.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runGcCommand } from './commands/gc.js';
import { runHomeForgetCommand } from './commands/home/forget.js';
import { runHomeListCommand } from './commands/home/list.js';
import { runInspectCommand } from './commands/inspect.js';
import { runListCommand } from './commands/list.js';
import { runMarkCommand } from './commands/mark.js';
import { runPasteCommand } from './commands/paste.js';
import { runRunCommand } from './commands/run.js';
import { runRecordExportCommand } from './commands/record-export.js';
import { runResizeCommand } from './commands/resize.js';
import { runScreenshotCommand } from './commands/screenshot.js';
import { runSendKeysCommand } from './commands/send-keys.js';
import { runSignalCommand } from './commands/signal.js';
import { runSkillsGetCommand } from './commands/skills/get.js';
import { runSkillsListCommand } from './commands/skills/list.js';
import { runSkillsPathCommand } from './commands/skills/path.js';
import { runSnapshotCommand } from './commands/snapshot.js';
import { runTypeCommand } from './commands/type.js';
import { runVersionCommand } from './commands/version.js';
import { runWaitCommand } from './commands/wait.js';
import {
  getCommandContext,
  parseTimeoutMsOption,
  resolveCommandContext,
  setCommandContext,
  type GlobalCliOptions,
} from './context.js';
import { CliError } from './errors.js';
import { exitCodeForError } from './exitCodes.js';
import { emitFailure, setColorEnabled } from './output.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SHELL,
  DEFAULT_TERM,
  HOST_RENDERER_ENV_KEY,
} from '../config/defaults.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';

function parseIntegerOption(value: string): number {
  return Number.parseInt(value, 10);
}

function parseNumberOption(value: string): number {
  return Number(value);
}

function collectStringOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function emitCliError(commandName: string, error: CliError): void {
  const json = process.argv.includes('--json');
  emitFailure({
    command: commandName,
    json,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
  });
  process.exitCode = exitCodeForError(error.code);
}

function getActionCommand(rawArgs: readonly unknown[]): Command {
  const maybeCommand = rawArgs.at(-1);
  invariant(
    maybeCommand instanceof Command,
    'Commander action expected command',
  );
  return maybeCommand;
}

function wrapAction<Args extends unknown[]>(
  commandName: string,
  fn: (...args: [...Args, CommandContext]) => Promise<void>,
): (...rawArgs: [...Args, Command]) => Promise<void> {
  return async (...rawArgs: [...Args, Command]) => {
    const command = getActionCommand(rawArgs);

    try {
      const context = await getCommandContext(command);
      setColorEnabled(context.colorEnabled);
      context.logger.debug(`starting ${commandName} command`, {
        logLevel: context.logLevel,
        renderer: context.rendererDefault,
        visualRenderer: context.rendererVisualDefault,
      });
      const args = rawArgs.slice(0, -1) as Args;
      await fn(...([...args, context] as [...Args, CommandContext]));
      context.logger.debug(`completed ${commandName} command`);
    } catch (error: unknown) {
      if (error instanceof CliError) {
        emitCliError(commandName, error);
        return;
      }

      throw error;
    }
  };
}

const CODING_AGENT_HELP_INTRO =
  'MANDATORY FOR CODING AGENTS: read the `agent-tty` skill first. If your agent already loaded that skill, follow it; otherwise run `agent-tty skills get agent-tty` before any other agent-tty command.';
const CODING_AGENT_HELP_OUTRO =
  'Coding agents: after loading the core `agent-tty` skill, run `agent-tty skills list` to discover other bundled skills and `agent-tty skills get <name>` to load one.';

async function main(): Promise<void> {
  const program = new Command()
    .name('agent-tty')
    .description('CLI for managing and controlling terminal sessions')
    .showHelpAfterError()
    .exitOverride();

  program
    .option('--home <path>', 'Override the agent-tty Home directory')
    .option(
      '--timeout-ms <n>',
      'Set a shared CLI timeout in milliseconds',
      parseTimeoutMsOption,
    )
    .option('--no-color', 'Disable ANSI color in human-readable output')
    .option('--log-level <level>', 'Set log level (debug, info, warn, error)')
    .option('--profile <name>', 'Default render profile name')
    .option(
      '--renderer <name>',
      'Renderer backend override. Defaults vary by command: semantic actions prefer libghostty-vt when available; visual artifacts default to ghostty-web.',
    );

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    const globalOptions = actionCommand.optsWithGlobals<GlobalCliOptions>();
    const rendererConfiguredByEnv =
      process.env.AGENT_TTY_RENDERER !== undefined;
    const context = await resolveCommandContext(globalOptions);
    process.env.AGENT_TTY_HOME = context.home;
    // Propagate the resolved log level to the process environment so that
    // subsystems instantiated outside the CLI context (e.g., renderer backends,
    // host processes) inherit the correct level via createProcessLogger().
    // This is intentional: threading a Logger instance through every factory
    // and constructor is a larger refactor with no user-visible benefit, since
    // the env var is set before any command handler runs.
    process.env.AGENT_TTY_LOG_LEVEL = context.logLevel;
    process.env[HOST_RENDERER_ENV_KEY] = context.rendererDefault;
    const rendererConfiguredExplicitly =
      globalOptions.renderer !== undefined ||
      rendererConfiguredByEnv ||
      context.configFile?.defaultRenderer !== undefined;
    if (rendererConfiguredExplicitly) {
      process.env.AGENT_TTY_RENDERER = context.rendererDefault;
    } else {
      delete process.env.AGENT_TTY_RENDERER;
    }
    setColorEnabled(context.colorEnabled);
    setCommandContext(actionCommand, context);
    context.logger.debug('resolved command context', {
      command: actionCommand.name(),
      home: context.home,
      logLevel: context.logLevel,
      renderer: context.rendererDefault,
      visualRenderer: context.rendererVisualDefault,
    });
  });

  program.addHelpText('beforeAll', `${CODING_AGENT_HELP_INTRO}\n\n`);
  program.addHelpText('afterAll', `\n${CODING_AGENT_HELP_OUTRO}\n`);

  const skillsCommand = program
    .command('skills')
    .description('Manage built-in skills');

  skillsCommand
    .command('list')
    .description('List all bundled skills')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'skills list',
        async (options: { json: boolean }, context: CommandContext) => {
          void context;
          await runSkillsListCommand(options);
        },
      ),
    );

  skillsCommand
    .command('get <name>')
    .description('Print a bundled skill by name')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'skills get',
        async (
          name: string,
          options: { json: boolean },
          context: CommandContext,
        ) => {
          void context;
          await runSkillsGetCommand(name, options);
        },
      ),
    );

  skillsCommand
    .command('path <name>')
    .description('Print the directory path of a bundled skill')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'skills path',
        async (
          name: string,
          options: { json: boolean },
          context: CommandContext,
        ) => {
          void context;
          await runSkillsPathCommand(name, options);
        },
      ),
    );

  const homeCommand = program
    .command('home')
    .description('Inspect and manage the per-machine Home Registry');

  homeCommand
    .command('list')
    .description('List registered agent-tty Homes')
    .option(
      '--all',
      'Include Homes whose Sessions are all terminal, not just Active Homes',
      false,
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'home list',
        async (
          options: { all: boolean; json: boolean },
          context: CommandContext,
        ) => {
          void context;
          await runHomeListCommand(options);
        },
      ),
    );

  homeCommand
    .command('forget <path>')
    .description('Remove a Home from the registry (does not delete it on disk)')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'home forget',
        async (
          path: string,
          options: { json: boolean },
          context: CommandContext,
        ) => {
          void context;
          await runHomeForgetCommand({ json: options.json, path });
        },
      ),
    );

  program
    .command('version')
    .description('Print version')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'version',
        async (options: { json: boolean }, context: CommandContext) => {
          void context;
          await runVersionCommand(options);
        },
      ),
    );

  program
    .command('doctor')
    .description('Check env')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'doctor',
        async (options: { json: boolean }, context: CommandContext) => {
          await runDoctorCommand({ ...options, context });
        },
      ),
    );

  // --- Session lifecycle ---
  program
    .command('create [command...]')
    .description('Create a session')
    .option('--command <path>', 'Legacy alias for --shell')
    .option('--shell <path>', 'Shell executable path', DEFAULT_SHELL)
    .option('--cwd <dir>', 'Working directory', process.cwd())
    .option('--cols <n>', 'Initial columns', parseIntegerOption, DEFAULT_COLS)
    .option('--rows <n>', 'Initial rows', parseIntegerOption, DEFAULT_ROWS)
    .option(
      '--env <key=value>',
      'Additional environment variable in KEY=VALUE format',
      collectStringOption,
      [],
    )
    .option('--term <value>', 'Terminal type', DEFAULT_TERM)
    .option('--name <name>', 'Human-readable session name')
    .option(
      '--idle-timeout-ms <ms>',
      'Idle timeout in milliseconds (0 = disabled)',
      parseIntegerOption,
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'create',
        async (
          command: string[],
          options: {
            command?: string;
            shell: string;
            cwd: string;
            cols: number;
            rows: number;
            env: string[];
            term: string;
            name?: string;
            idleTimeoutMs?: number;
            json: boolean;
          },
          context: CommandContext,
        ) => {
          await runCreateCommand({
            context,
            json: options.json,
            command,
            shellPath: options.command ?? options.shell,
            cwd: options.cwd,
            cols: options.cols,
            rows: options.rows,
            envEntries: options.env,
            term: options.term,
            ...(options.name !== undefined ? { name: options.name } : {}),
            ...(options.idleTimeoutMs !== undefined
              ? { idleTimeoutMs: options.idleTimeoutMs }
              : {}),
          });
        },
      ),
    );

  program
    .command('list')
    .alias('ls')
    .description('List sessions')
    .option('--all', 'Include exited sessions', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'list',
        async (
          options: { all: boolean; json: boolean },
          context: CommandContext,
        ) => {
          await runListCommand({ ...options, context });
        },
      ),
    );

  program
    .command('inspect <session-id>')
    .description('Inspect a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'inspect',
        async (
          sessionId: string,
          options: { json: boolean },
          context: CommandContext,
        ) => {
          await runInspectCommand({
            context,
            json: options.json,
            sessionId,
          });
        },
      ),
    );

  program
    .command('destroy <session-id>')
    .description('Destroy a session')
    .option('--force', 'Skip graceful shutdown', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'destroy',
        async (
          sessionId: string,
          options: { force: boolean; json: boolean },
          context: CommandContext,
        ) => {
          void context;
          await runDestroyCommand({
            json: options.json,
            sessionId,
            force: options.force,
          });
        },
      ),
    );

  program
    .command('gc')
    .description('Clean up stale or exited sessions')
    .option('--dry-run', 'Report what would be removed without deleting', false)
    .option(
      '--stale-only',
      'Only remove sessions that reconcile from active to exited',
      false,
    )
    .option(
      '--older-than <duration>',
      'Only remove sessions older than a duration like 30m, 1h, or 7d',
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'gc',
        async (
          options: {
            dryRun: boolean;
            staleOnly: boolean;
            olderThan?: string;
            json: boolean;
          },
          context: CommandContext,
        ) => {
          await runGcCommand({
            context,
            json: options.json,
            dryRun: options.dryRun,
            staleOnly: options.staleOnly,
            olderThan: options.olderThan,
          });
        },
      ),
    );

  // --- Session control ---
  program
    .command('type <session-id> [text]')
    .description('Type text into a session')
    .option('--file <path>', 'Read text to type from a file')
    .option('--append-newline', 'Append a newline after the typed text', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'type',
        async (
          sessionId: string,
          text: string | undefined,
          options: { file?: string; appendNewline: boolean; json: boolean },
          context: CommandContext,
        ) => {
          await runTypeCommand({
            context,
            json: options.json,
            sessionId,
            text,
            appendNewline: options.appendNewline,
            ...(options.file !== undefined ? { file: options.file } : {}),
          });
        },
      ),
    );

  program
    .command('paste <session-id> [text]')
    .description('Paste text into a session')
    .option('--file <path>', 'Read text to paste from a file')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'paste',
        async (
          sessionId: string,
          text: string | undefined,
          options: { file?: string; json: boolean },
          context: CommandContext,
        ) => {
          await runPasteCommand({
            context,
            json: options.json,
            sessionId,
            text,
            ...(options.file !== undefined ? { file: options.file } : {}),
          });
        },
      ),
    );

  program
    .command('run <session-id> [command]')
    .description(
      'Run a command in a session and optionally wait for completion',
    )
    .option('--file <path>', 'Read command text from a file')
    .option('--timeout <ms>', 'Wait timeout in milliseconds', '30000')
    .option('--no-wait', 'Do not wait for completion')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'run',
        async (
          sessionId: string,
          text: string | undefined,
          options: {
            file?: string;
            timeout: string;
            wait: boolean;
            json: boolean;
          },
          context: CommandContext,
        ) => {
          await runRunCommand({
            context,
            json: options.json,
            sessionId,
            text,
            ...(options.file !== undefined ? { file: options.file } : {}),
            timeout: Number.parseInt(options.timeout, 10),
            wait: options.wait,
          });
        },
      ),
    );

  program
    .command('batch <session-id> [steps]')
    .description(
      'Run an ordered sequence of input-and-wait steps in one command',
    )
    .option('--file <path>', 'Read the JSON step array from a file')
    .option('--keep-going', 'Attempt every step regardless of failures', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'batch',
        async (
          sessionId: string,
          steps: string | undefined,
          options: { file?: string; keepGoing: boolean; json: boolean },
          context: CommandContext,
        ) => {
          await runBatchCommand({
            context,
            json: options.json,
            sessionId,
            steps,
            ...(options.file !== undefined ? { file: options.file } : {}),
            keepGoing: options.keepGoing,
          });
        },
      ),
    );

  program
    .command('mark <session-id> <label>')
    .description('Add a marker to a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'mark',
        async (
          sessionId: string,
          label: string,
          options: { json: boolean },
          context: CommandContext,
        ) => {
          await runMarkCommand({
            context,
            json: options.json,
            sessionId,
            label,
          });
        },
      ),
    );

  program
    .command('send-keys <session-id> <keys...>')
    .description('Send keys to a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'send-keys',
        async (
          sessionId: string,
          keys: string[],
          options: { json: boolean },
          context: CommandContext,
        ) => {
          await runSendKeysCommand({
            context,
            json: options.json,
            sessionId,
            keys,
          });
        },
      ),
    );

  program
    .command('resize <session-id>')
    .description('Resize a session')
    .requiredOption('--cols <n>', 'Columns', parseIntegerOption)
    .requiredOption('--rows <n>', 'Rows', parseIntegerOption)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'resize',
        async (
          sessionId: string,
          options: { cols: number; rows: number; json: boolean },
          context: CommandContext,
        ) => {
          await runResizeCommand({
            context,
            json: options.json,
            sessionId,
            cols: options.cols,
            rows: options.rows,
          });
        },
      ),
    );

  program
    .command('signal <session-id> <signal>')
    .description('Send a signal to a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'signal',
        async (
          sessionId: string,
          signal: string,
          options: { json: boolean },
          context: CommandContext,
        ) => {
          await runSignalCommand({
            context,
            json: options.json,
            sessionId,
            signal,
          });
        },
      ),
    );

  // --- Observation ---
  program
    .command('snapshot <session-id>')
    .description('Capture a terminal snapshot')
    .option(
      '--format <format>',
      "Output format: 'structured' or 'text'",
      'structured',
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .option('--include-scrollback', 'Include scrollback buffer lines', false)
    .option(
      '--include-cells',
      'Include per-cell style data in structured snapshots',
      false,
    )
    .action(
      wrapAction(
        'snapshot',
        async (
          sessionId: string,
          options: {
            format: string;
            json: boolean;
            includeScrollback: boolean;
            includeCells: boolean;
          },
          context: CommandContext,
        ) => {
          await runSnapshotCommand({
            context,
            json: options.json,
            sessionId,
            format: options.format,
            includeScrollback: options.includeScrollback,
            includeCells: options.includeCells,
          });
        },
      ),
    );

  program
    .command('screenshot <session-id>')
    .description('Capture a rendered screenshot')
    .option('--profile <name>', 'Render profile name')
    .option('--show-cursor', 'Show the terminal cursor in the screenshot')
    .option('--hide-cursor', 'Hide the terminal cursor in the screenshot')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'screenshot',
        async (
          sessionId: string,
          options: {
            profile?: string;
            showCursor: boolean;
            hideCursor: boolean;
            json: boolean;
          },
          context: CommandContext,
        ) => {
          if (options.showCursor && options.hideCursor) {
            throw makeCliError(ERROR_CODES.INVALID_INPUT, {
              message:
                '--show-cursor and --hide-cursor are mutually exclusive.',
            });
          }

          const cursorVisible = options.showCursor
            ? true
            : options.hideCursor
              ? false
              : undefined;

          await runScreenshotCommand({
            context,
            json: options.json,
            sessionId,
            ...(options.profile === undefined
              ? {}
              : { profile: options.profile }),
            ...(cursorVisible === undefined
              ? {}
              : { showCursor: cursorVisible }),
          });
        },
      ),
    );

  program
    .command('dashboard')
    .alias('d')
    .description(
      'Watch what your agents are doing in their shells: a read-only, live dashboard of your sessions',
    )
    .option(
      '--all',
      'Start showing all sessions (active and terminal), not just active ones',
      false,
    )
    .option('--session <id>', 'Preselect a session to watch on launch')
    .action(
      wrapAction(
        'dashboard',
        async (
          options: { all: boolean; session?: string },
          context: CommandContext,
        ) => {
          await runDashboardCommand({
            context,
            all: options.all,
            ...(options.session === undefined
              ? {}
              : { session: options.session }),
          });
        },
      ),
    );

  const recordCommand = program
    .command('record')
    .description('Manage recorded session artifacts');

  recordCommand
    .command('export <session-id>')
    .description('Export a recorded session artifact')
    .requiredOption('--format <format>', "Export format: 'asciicast' or 'webm'")
    .option('--out <path>', 'Explicit output path')
    .option('--profile <name>', 'Render profile name')
    .option(
      '--timing <mode>',
      'Replay timing mode for WebM: recorded (default), accelerated, max-speed',
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'record export',
        async (
          sessionId: string,
          options: {
            format: string;
            out?: string;
            profile?: string;
            timing?: string;
            json: boolean;
          },
          context: CommandContext,
        ) => {
          await runRecordExportCommand({
            context,
            json: options.json,
            sessionId,
            format: options.format,
            ...(options.out !== undefined ? { out: options.out } : {}),
            ...(options.profile !== undefined
              ? { profile: options.profile }
              : {}),
            ...(options.timing !== undefined ? { timing: options.timing } : {}),
          });
        },
      ),
    );

  program
    .command('wait <session-id>')
    .description('Wait for a session condition')
    .option('--exit', 'Wait for process exit', false)
    .option('--idle-ms <ms>', 'Wait for output idle period', parseIntegerOption)
    .option(
      '--timeout <ms>',
      'Maximum wait time in milliseconds (0 for infinite)',
      parseIntegerOption,
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .option('--text <string>', 'Wait for text to appear in rendered output')
    .option('--regex <pattern>', 'Wait for regex match in rendered output')
    .option(
      '--screen-stable-ms <ms>',
      'Wait for screen to be stable for given ms',
      parseIntegerOption,
    )
    .option(
      '--cursor-row <n>',
      'Wait for cursor row in rendered output (0-based)',
      parseNumberOption,
    )
    .option(
      '--cursor-col <n>',
      'Wait for cursor column in rendered output (0-based)',
      parseNumberOption,
    )
    .option(
      '--after-seq <n>',
      'Only match renderer snapshots produced after this Event Log sequence',
      parseIntegerOption,
    )
    .action(
      wrapAction(
        'wait',
        async (
          sessionId: string,
          options: {
            exit: boolean;
            idleMs?: number;
            timeout?: number;
            json: boolean;
            text?: string;
            regex?: string;
            screenStableMs?: number;
            cursorRow?: number;
            cursorCol?: number;
            afterSeq?: number;
          },
          context: CommandContext,
        ) => {
          await runWaitCommand({
            context,
            json: options.json,
            sessionId,
            waitForExit: options.exit,
            idleMs: options.idleMs,
            timeout: options.timeout,
            text: options.text,
            regex: options.regex,
            screenStableMs: options.screenStableMs,
            cursorRow: options.cursorRow,
            cursorCol: options.cursorCol,
            afterSeq: options.afterSeq,
          });
        },
      ),
    );

  program
    .command('_host <session-id>', { hidden: true })
    .description('Internal: run the session host process')
    .action(async (sessionId: string) => {
      const { runHost } = await import('../host/hostMain.js');
      await runHost(sessionId);
    });

  await program.parseAsync();
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof CommanderError) {
    process.exitCode = error.code === 'commander.helpDisplayed' ? 0 : 2;
  } else if (error instanceof CliError) {
    setColorEnabled(!process.argv.includes('--no-color'));
    emitCliError('agent-tty', error);
  } else {
    throw error;
  }
}
