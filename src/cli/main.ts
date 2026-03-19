#!/usr/bin/env node

import process from 'node:process';

import { Command } from 'commander';

import { runCreateCommand } from './commands/create.js';
import { runDestroyCommand } from './commands/destroy.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runInspectCommand } from './commands/inspect.js';
import { runListCommand } from './commands/list.js';
import { runPasteCommand } from './commands/paste.js';
import { runResizeCommand } from './commands/resize.js';
import { runSendKeysCommand } from './commands/send-keys.js';
import { runSignalCommand } from './commands/signal.js';
import { runTypeCommand } from './commands/type.js';
import { runVersionCommand } from './commands/version.js';
import { runWaitCommand } from './commands/wait.js';
import { CliError } from './errors.js';
import { emitFailure } from './output.js';

function parseIntegerOption(value: string): number {
  return Number.parseInt(value, 10);
}

async function main(): Promise<void> {
  const program = new Command()
    .name('agent-terminal')
    .description('Terminal CLI')
    .showHelpAfterError();

  program
    .command('version')
    .description('Print version')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(async (options: { json: boolean }) => {
      await runVersionCommand(options);
    });

  program
    .command('doctor')
    .description('Check env')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(async (options: { json: boolean }) => {
      await runDoctorCommand(options);
    });

  // --- Session lifecycle ---
  program
    .command('create [command...]')
    .description('Create a session')
    .option(
      '--command <cmd>',
      'Command string to run (defaults to the user shell)',
      process.env.SHELL ?? process.env.ComSpec ?? 'sh',
    )
    .option('--cwd <dir>', 'Working directory', process.cwd())
    .option('--cols <n>', 'Initial columns', parseIntegerOption, 80)
    .option('--rows <n>', 'Initial rows', parseIntegerOption, 24)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
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
    );

  program
    .command('list')
    .description('List sessions')
    .option('--all', 'Include exited sessions', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(async (options: { all: boolean; json: boolean }) => {
      await runListCommand(options);
    });

  program
    .command('inspect <session-id>')
    .description('Inspect a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(async (sessionId: string, options: { json: boolean }) => {
      await runInspectCommand({
        json: options.json,
        sessionId,
      });
    });

  program
    .command('destroy <session-id>')
    .description('Destroy a session')
    .option('--force', 'Skip graceful shutdown', false)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      async (sessionId: string, options: { force: boolean; json: boolean }) => {
        await runDestroyCommand({
          json: options.json,
          sessionId,
          force: options.force,
        });
      },
    );

  // --- Session control ---
  program
    .command('type <session-id> <text>')
    .description('Type text into a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      async (sessionId: string, text: string, options: { json: boolean }) => {
        await runTypeCommand({
          json: options.json,
          sessionId,
          text,
        });
      },
    );

  program
    .command('paste <session-id> <text>')
    .description('Paste text into a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      async (sessionId: string, text: string, options: { json: boolean }) => {
        await runPasteCommand({
          json: options.json,
          sessionId,
          text,
        });
      },
    );

  program
    .command('send-keys <session-id> <keys...>')
    .description('Send keys to a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      async (sessionId: string, keys: string[], options: { json: boolean }) => {
        await runSendKeysCommand({
          json: options.json,
          sessionId,
          keys,
        });
      },
    );

  program
    .command('resize <session-id>')
    .description('Resize a session')
    .requiredOption('--cols <n>', 'Columns', parseIntegerOption)
    .requiredOption('--rows <n>', 'Rows', parseIntegerOption)
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
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
    );

  program
    .command('signal <session-id> <signal>')
    .description('Send a signal to a session')
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      async (sessionId: string, signal: string, options: { json: boolean }) => {
        await runSignalCommand({
          json: options.json,
          sessionId,
          signal,
        });
      },
    );

  // --- Observation ---
  program
    .command('wait <session-id>')
    .description('Wait for a session condition')
    .option('--exit', 'Wait for process exit', false)
    .option('--idle-ms <ms>', 'Wait for output idle period', parseIntegerOption)
    .option(
      '--timeout <ms>',
      'Maximum wait time in milliseconds',
      parseIntegerOption,
    )
    .option('--json', 'Emit a JSON command envelope', false)
    .action(
      async (
        sessionId: string,
        options: {
          exit: boolean;
          idleMs?: number;
          timeout?: number;
          json: boolean;
        },
      ) => {
        await runWaitCommand({
          json: options.json,
          sessionId,
          waitForExit: options.exit,
          idleMs: options.idleMs,
          timeout: options.timeout,
        });
      },
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
