import process from 'node:process';

import { invariant } from './assert.js';

export const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];

export type LogSink = (chunk: string) => void;

const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

function defaultLogSink(chunk: string): void {
  process.stderr.write(chunk);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === 'string' &&
    (LOG_LEVEL_VALUES as readonly string[]).includes(value)
  );
}

export function assertLogLevel(
  value: unknown,
  message = 'log level must be one of debug, info, warn, or error',
): asserts value is LogLevel {
  invariant(isLogLevel(value), message);
}

export function resolveLogLevel(raw?: string): LogLevel {
  if (raw === undefined) {
    return DEFAULT_LOG_LEVEL;
  }

  assertLogLevel(raw);
  return raw;
}

function formatLogDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ?? detail.message;
  }

  if (
    typeof detail === 'string' ||
    typeof detail === 'number' ||
    typeof detail === 'boolean' ||
    typeof detail === 'bigint' ||
    typeof detail === 'symbol'
  ) {
    return String(detail);
  }

  if (detail === undefined) {
    return 'undefined';
  }

  if (detail === null) {
    return 'null';
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return Object.prototype.toString.call(detail);
  }
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;

  public constructor(level: LogLevel, sink: LogSink = defaultLogSink) {
    assertLogLevel(
      level,
      'logger level must be one of debug, info, warn, or error',
    );
    invariant(typeof sink === 'function', 'logger sink must be a function');

    this.level = level;
    this.sink = sink;
  }

  public debug(message: string, ...details: readonly unknown[]): void {
    this.log('debug', message, details);
  }

  public info(message: string, ...details: readonly unknown[]): void {
    this.log('info', message, details);
  }

  public warn(message: string, ...details: readonly unknown[]): void {
    this.log('warn', message, details);
  }

  public error(message: string, ...details: readonly unknown[]): void {
    this.log('error', message, details);
  }

  public shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[this.level];
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  private log(
    level: LogLevel,
    message: string,
    details: readonly unknown[],
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const suffix =
      details.length === 0
        ? ''
        : ` ${details.map((detail) => formatLogDetail(detail)).join(' ')}`;
    this.sink(`[agent-tty] ${level}: ${message}${suffix}\n`);
  }
}

export function createLogger(level: LogLevel, sink?: LogSink): Logger {
  return new Logger(level, sink);
}

export function createProcessLogger(
  env: NodeJS.ProcessEnv = process.env,
  sink?: LogSink,
): Logger {
  return createLogger(resolveLogLevel(env.AGENT_TTY_LOG_LEVEL), sink);
}
