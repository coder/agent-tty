import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigFileSchema,
  loadConfigFile,
} from '../../../src/config/resolveConfig.js';

const temporaryHomes: string[] = [];

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-terminal-config-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('loadConfigFile', () => {
  it('loads a valid config file from disk', async () => {
    const home = await createTemporaryHome();
    const config = {
      logLevel: 'debug',
      defaultProfile: 'reference-dark',
      defaultShell: '/bin/bash',
      defaultTerm: 'xterm-256color',
      defaultCols: 120,
      defaultRows: 40,
      idleTimeoutMs: 5000,
    } as const;
    await writeFile(
      join(home, 'config.json'),
      `${JSON.stringify(config)}\n`,
      'utf8',
    );

    await expect(loadConfigFile(home)).resolves.toEqual(config);
  });

  it('returns null when the config file does not exist', async () => {
    const home = await createTemporaryHome();

    await expect(loadConfigFile(home)).resolves.toBeNull();
  });

  it('throws when the config file exists but contains invalid JSON', async () => {
    const home = await createTemporaryHome();
    await writeFile(join(home, 'config.json'), '{"logLevel":', 'utf8');

    await expect(loadConfigFile(home)).rejects.toThrow(/contains invalid JSON/);
  });

  it('throws when the config file fails schema validation', async () => {
    const home = await createTemporaryHome();
    await writeFile(
      join(home, 'config.json'),
      `${JSON.stringify({ logLevel: 'trace' })}\n`,
      'utf8',
    );

    await expect(loadConfigFile(home)).rejects.toThrow(/logLevel/);
  });
});

describe('ConfigFileSchema', () => {
  it('accepts supported edge cases and rejects invalid values', () => {
    expect(ConfigFileSchema.safeParse({ idleTimeoutMs: 0 }).success).toBe(true);
    expect(ConfigFileSchema.safeParse({ defaultCols: 1 }).success).toBe(true);
    expect(ConfigFileSchema.safeParse({ defaultRows: 0 }).success).toBe(false);
    expect(ConfigFileSchema.safeParse({ idleTimeoutMs: -1 }).success).toBe(
      false,
    );
    expect(ConfigFileSchema.safeParse({ defaultCols: 80.5 }).success).toBe(
      false,
    );
    expect(ConfigFileSchema.safeParse({ extra: true }).success).toBe(false);
  });
});
