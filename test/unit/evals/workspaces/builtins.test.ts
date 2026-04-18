import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atty-ws-builtins-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function loadFreshWorkspaceModules() {
  vi.resetModules();

  const builtinsModule =
    await import('../../../../evals/workspaces/builtins.js');
  const registryModule =
    await import('../../../../evals/workspaces/registry.js');
  const resolverModule =
    await import('../../../../evals/workspaces/resolver.js');

  registryModule.clearPresetsForTesting();

  return {
    ...builtinsModule,
    ...registryModule,
    ...resolverModule,
  };
}

describe('registerBuiltinPresets', () => {
  it('registers agent-tty-smoke and makes repeated registration a no-op', async () => {
    const { lookupPreset, registerBuiltinPresets } =
      await loadFreshWorkspaceModules();

    expect(() => registerBuiltinPresets()).not.toThrow();
    const firstLookup = lookupPreset('agent-tty-smoke');

    expect(() => registerBuiltinPresets()).not.toThrow();
    const secondLookup = lookupPreset('agent-tty-smoke');

    expect(firstLookup).toEqual(secondLookup);
    expect(firstLookup.mode).toBe('isolated');
    expect(firstLookup.bootstrap).toHaveLength(1);
    const bootstrap = firstLookup.bootstrap;
    if (bootstrap === undefined) {
      throw new Error('Expected agent-tty-smoke bootstrap to be defined');
    }
    expect(bootstrap[0]?.command).toBe(process.execPath);
    expect(bootstrap[0]?.args?.[0]).toBe('-e');
  });

  it('resolves the builtin preset with one bootstrap step and no env', async () => {
    const { lookupPreset, registerBuiltinPresets, resolveWorkspacePreset } =
      await loadFreshWorkspaceModules();
    const homeDir = createTempDir();

    registerBuiltinPresets();
    const plan = resolveWorkspacePreset(
      { homeDir },
      lookupPreset('agent-tty-smoke'),
    );

    expect(plan.bootstrapCount).toBe(1);
    expect(plan).not.toHaveProperty('env');
  });
});
