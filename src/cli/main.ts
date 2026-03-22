#!/usr/bin/env node

import process from 'node:process';

import { Command } from 'commander';

import { runCreateCommand } from './commands/create.js';
import { runDestroyCommand } from './commands/destroy.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runGcCommand } from './commands/gc.js';
import { runInspectCommand } from './commands/inspect.js';
import { runListCommand } from './commands/list.js';
import { runMarkCommand } from './commands/mark.js';
import { runPasteCommand } from './commands/paste.js';
import { runRecordExportCommand } from './commands/record-export.js';
import { runResizeCommand } from './commands/resize.js';
import { runScreenshotCommand } from './commands/screenshot.js';
import { runSendKeysCommand } from './commands/send-keys.js';
import { runSignalCommand } from './commands/signal.js';
import { runSnapshotCommand } from './commands/snapshot.js';
import { runTypeCommand } from './commands/type.js';
import { runVersionCommand } from './commands/version.js';
import { runWaitCommand } from './commands/wait.js';
import { CliError } from './errors.js';
import { emitFailure } from './output.js';

function parseIntegerOption(value: string): number {
  return Number.parseInt(value, 10);
}

function wrapAction<Args extends unknown[]>(
  commandName: string,
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (error: unknown) {
      if (error instanceof CliError) {
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
        process.exitCode = 1;
        return;
      }

      throw error;
    }
  };
}

async function main(): Promise<void> {
  const program = new Command()
    .name('agent-terminal')
    .description('CLI for managing and controlling terminal sessions')
    .showHelpAfterError();

  program
    .command('version')
    .description('Print version')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction('version', async (options: { json: boolean }) => {
        await runVersionCommand(options);
      }),
    );

  program
    .command('doctor')
    .description('Check env')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction('doctor', async (options: { json: boolean }) => {
        await runDoctorCommand(options);
      }),
    );

  // --- Session lifecycle ---
  program
    .command('create [command...]')
    .description('Create a session')
    .option(
      '--command <cmd>',
      'Shell executable (defaults to $SHELL or sh)',
      process.env.SHELL ?? process.env.ComSpec ?? 'sh',
    )
    .option('--cwd <dir>', 'Working directory', process.cwd())
    .option('--cols <n>', 'Initial columns', parseIntegerOption, 80)
    .option('--rows <n>', 'Initial rows', parseIntegerOption, 24)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'create',
        async (
          command: string[],
          options: {
            command: string;
            cwd: string;
            cols: number;
            rows: number;
            json: boolean;
          },
        ) => {
          await runCreateCommand({
            json: options.json,
            command,
            shellCommand: options.command,
            cwd: options.cwd,
            cols: options.cols,
            rows: options.rows,
          });
        },
      ),
    );

  program
    .command('list')
    .description('List sessions')
    .option('--all', 'Include exited sessions', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction('list', async (options: { all: boolean; json: boolean }) => {
        await runListCommand(options);
      }),
    );

  program
    .command('inspect <session-id>')
    .description('Inspect a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'inspect',
        async (sessionId: string, options: { json: boolean }) => {
          await runInspectCommand({
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
        ) => {
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
        async (options: {
          dryRun: boolean;
          staleOnly: boolean;
          olderThan?: string;
          json: boolean;
        }) => {
          await runGcCommand({
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
    .command('type <session-id> <text>')
    .description('Type text into a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'type',
        async (sessionId: string, text: string, options: { json: boolean }) => {
          await runTypeCommand({
            json: options.json,
            sessionId,
            text,
          });
        },
      ),
    );

  program
    .command('paste <session-id> <text>')
    .description('Paste text into a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'paste',
        async (sessionId: string, text: string, options: { json: boolean }) => {
          await runPasteCommand({
            json: options.json,
            sessionId,
            text,
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
        ) => {
          await runMarkCommand({
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
        ) => {
          await runSendKeysCommand({
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
        ) => {
          await runResizeCommand({
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
        ) => {
          await runSignalCommand({
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
    .action(
      wrapAction(
        'snapshot',
        async (
          sessionId: string,
          options: { format: string; json: boolean },
        ) => {
          await runSnapshotCommand({
            json: options.json,
            sessionId,
            format: options.format,
          });
        },
      ),
    );

  program
    .command('screenshot <session-id>')
    .description('Capture a rendered screenshot')
    .option('--profile <name>', 'Render profile name', 'reference-dark')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'screenshot',
        async (
          sessionId: string,
          options: { profile: string; json: boolean },
        ) => {
          await runScreenshotCommand({
            json: options.json,
            sessionId,
            profile: options.profile,
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
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      wrapAction(
        'record export',
        async (
          sessionId: string,
          options: {
            format: string;
            out?: string;
            json: boolean;
          },
        ) => {
          await runRecordExportCommand({
            json: options.json,
            sessionId,
            format: options.format,
            ...(options.out !== undefined ? { out: options.out } : {}),
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
          },
        ) => {
          await runWaitCommand({
            json: options.json,
            sessionId,
            waitForExit: options.exit,
            idleMs: options.idleMs,
            timeout: options.timeout,
            text: options.text,
            regex: options.regex,
            screenStableMs: options.screenStableMs,
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
  if (error instanceof CliError) {
    const json = process.argv.includes('--json');
    emitFailure({
      command: 'agent-terminal',
      json,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    });
    process.exitCode = 1;
  } else {
    throw error;
  }
}
