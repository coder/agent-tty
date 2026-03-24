import { describe, expect, it } from 'vitest';

import {
  Logger,
  createLogger,
  createProcessLogger,
  isLogLevel,
  resolveLogLevel,
} from '../../../src/util/logger.js';

function createSink() {
  const writes: string[] = [];
  return {
    writes,
    sink: (chunk: string) => {
      writes.push(chunk);
    },
  };
}

describe('Logger', () => {
  it('returns the expected shouldLog() matrix for every level', () => {
    const expectations = [
      {
        loggerLevel: 'debug' as const,
        expected: { debug: true, info: true, warn: true, error: true },
      },
      {
        loggerLevel: 'info' as const,
        expected: { debug: false, info: true, warn: true, error: true },
      },
      {
        loggerLevel: 'warn' as const,
        expected: { debug: false, info: false, warn: true, error: true },
      },
      {
        loggerLevel: 'error' as const,
        expected: { debug: false, info: false, warn: false, error: true },
      },
    ];

    for (const { loggerLevel, expected } of expectations) {
      const logger = createLogger(loggerLevel);

      expect(logger.shouldLog('debug')).toBe(expected.debug);
      expect(logger.shouldLog('info')).toBe(expected.info);
      expect(logger.shouldLog('warn')).toBe(expected.warn);
      expect(logger.shouldLog('error')).toBe(expected.error);
    }
  });

  it('writes only the log methods permitted by the configured threshold', () => {
    const expectations = [
      {
        loggerLevel: 'debug' as const,
        expectedWrites: [
          '[agent-terminal] debug: visible debug\n',
          '[agent-terminal] info: visible info\n',
          '[agent-terminal] warn: visible warn\n',
          '[agent-terminal] error: visible error\n',
        ],
      },
      {
        loggerLevel: 'info' as const,
        expectedWrites: [
          '[agent-terminal] info: visible info\n',
          '[agent-terminal] warn: visible warn\n',
          '[agent-terminal] error: visible error\n',
        ],
      },
      {
        loggerLevel: 'warn' as const,
        expectedWrites: [
          '[agent-terminal] warn: visible warn\n',
          '[agent-terminal] error: visible error\n',
        ],
      },
      {
        loggerLevel: 'error' as const,
        expectedWrites: ['[agent-terminal] error: visible error\n'],
      },
    ];

    for (const { loggerLevel, expectedWrites } of expectations) {
      const { writes, sink } = createSink();
      const logger = createLogger(loggerLevel, sink);

      logger.debug('visible debug');
      logger.info('visible info');
      logger.warn('visible warn');
      logger.error('visible error');

      expect(writes).toEqual(expectedWrites);
    }
  });

  it('formats details and exposes the configured level', () => {
    const { writes, sink } = createSink();
    const logger = new Logger('debug', sink);

    logger.debug('context', { command: 'doctor' }, new Error('boom'));

    expect(logger.getLevel()).toBe('debug');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[agent-terminal] debug: context');
    expect(writes[0]).toContain('{"command":"doctor"}');
    expect(writes[0]).toContain('boom');
  });

  it('formats null, undefined, primitive, and circular details through log methods', () => {
    const { writes, sink } = createSink();
    const logger = createLogger('debug', sink);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    logger.debug('msg', null);
    logger.debug('msg', undefined);
    logger.debug('msg', 42);
    logger.debug('msg', true);
    expect(() => logger.debug('msg', circular)).not.toThrow();
    expect(() => logger.debug('msg', Symbol('test'))).not.toThrow();
    expect(() => logger.debug('msg', BigInt(42))).not.toThrow();

    expect(writes).toEqual([
      '[agent-terminal] debug: msg null\n',
      '[agent-terminal] debug: msg undefined\n',
      '[agent-terminal] debug: msg 42\n',
      '[agent-terminal] debug: msg true\n',
      '[agent-terminal] debug: msg [object Object]\n',
      '[agent-terminal] debug: msg Symbol(test)\n',
      '[agent-terminal] debug: msg 42\n',
    ]);
  });

  it('creates a process logger from env', () => {
    const { writes, sink } = createSink();
    const logger = createProcessLogger(
      { AGENT_TERMINAL_LOG_LEVEL: 'error' },
      sink,
    );

    logger.warn('hidden warn');
    logger.error('visible error');

    expect(writes).toEqual(['[agent-terminal] error: visible error\n']);
  });

  it('defaults process loggers to info when the env var is missing or undefined', () => {
    for (const env of [
      {},
      { AGENT_TERMINAL_LOG_LEVEL: undefined },
    ] satisfies Array<NodeJS.ProcessEnv>) {
      const { writes, sink } = createSink();
      const logger = createProcessLogger(env, sink);

      expect(logger.getLevel()).toBe('info');

      logger.debug('hidden debug');
      logger.info('visible info');

      expect(writes).toEqual(['[agent-terminal] info: visible info\n']);
    }
  });

  it('rejects invalid logger levels', () => {
    expect(() => new Logger('trace' as never)).toThrow(
      'logger level must be one of debug, info, warn, or error',
    );
  });
});

describe('resolveLogLevel', () => {
  it('returns the default level when no raw level is provided', () => {
    expect(resolveLogLevel()).toBe('info');
  });

  it('returns valid levels unchanged', () => {
    expect(resolveLogLevel('debug')).toBe('debug');
  });

  it('throws for invalid levels', () => {
    expect(() => resolveLogLevel('invalid')).toThrow(
      'log level must be one of debug, info, warn, or error',
    );
  });
});

describe('isLogLevel', () => {
  it('identifies valid and invalid log levels', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('info')).toBe(true);
    expect(isLogLevel('WARN')).toBe(false);
    expect(isLogLevel('')).toBe(false);
    expect(isLogLevel(42)).toBe(false);
  });
});
