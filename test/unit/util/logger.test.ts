import { describe, expect, it } from 'vitest';

import {
  Logger,
  createLogger,
  createProcessLogger,
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
  it('gates writes by log level', () => {
    const { writes, sink } = createSink();
    const logger = createLogger('warn', sink);

    logger.debug('hidden debug');
    logger.info('hidden info');
    logger.warn('visible warn');
    logger.error('visible error');

    expect(writes).toEqual([
      '[agent-terminal] warn: visible warn\n',
      '[agent-terminal] error: visible error\n',
    ]);
  });

  it('formats details and exposes the configured level', () => {
    const { writes, sink } = createSink();
    const logger = new Logger('debug', sink);

    logger.debug('context', { command: 'doctor' }, new Error('boom'));

    expect(logger.getLevel()).toBe('debug');
    expect(logger.shouldLog('info')).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[agent-terminal] debug: context');
    expect(writes[0]).toContain('{"command":"doctor"}');
    expect(writes[0]).toContain('boom');
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

  it('rejects invalid logger levels', () => {
    expect(() => new Logger('trace' as never)).toThrow(
      'logger level must be one of debug, info, warn, or error',
    );
  });
});
