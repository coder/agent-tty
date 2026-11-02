import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSupportedNodeRange: vi.fn<() => Promise<string>>(),
}));

vi.mock('../../../src/util/packageMetadata.js', () => ({
  loadSupportedNodeRange: mocks.loadSupportedNodeRange,
}));

import { warnIfUnsupportedNode } from '../../../src/cli/nodeRuntime.js';
import { createLogger } from '../../../src/util/logger.js';

function captureLogger(): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger('info', (chunk) => {
      lines.push(chunk);
    }),
  };
}

describe('warnIfUnsupportedNode', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('warns when the Node version is outside the range', async () => {
    mocks.loadSupportedNodeRange.mockResolvedValue('>=24.0.0 <27');
    const { lines, logger } = captureLogger();

    await warnIfUnsupportedNode(logger, '22.0.0');

    expect(lines).toEqual([
      '[agent-tty] warn: Node 22.0.0 is not supported. agent-tty requires Node >=24.0.0 <27. Run `agent-tty doctor` to check the runtime.\n',
    ]);
  });

  it('stays quiet when the Node version is in the range', async () => {
    mocks.loadSupportedNodeRange.mockResolvedValue('>=24.0.0 <27');
    const { lines, logger } = captureLogger();

    await warnIfUnsupportedNode(logger, '26.2.0');

    expect(lines).toEqual([]);
  });

  it('skips the check when engines.node uses an unsupported range', async () => {
    mocks.loadSupportedNodeRange.mockResolvedValue('^24 || ^26');
    const { lines, logger } = captureLogger();

    await expect(
      warnIfUnsupportedNode(logger, '22.0.0'),
    ).resolves.toBeUndefined();

    expect(lines).toEqual([]);
  });

  it('skips the check when package.json cannot be read', async () => {
    mocks.loadSupportedNodeRange.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    );
    const { lines, logger } = captureLogger();

    await expect(
      warnIfUnsupportedNode(logger, '22.0.0'),
    ).resolves.toBeUndefined();

    expect(lines).toEqual([]);
  });
});
