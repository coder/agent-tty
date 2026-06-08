import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createHomeRegistry,
  normalizeHomePath,
  resolveHomeRegistryPath,
  type HomeRegistry,
} from '../../../src/storage/homeRegistry.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempRegistryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tty-registry-'));
  temporaryDirectories.push(directory);
  // Nest under a not-yet-created subdir so the atomic write must mkdir -p.
  return join(directory, 'state', 'agent-tty', 'homes.json');
}

/** A registry over a temp file with a controllable clock and identity realpath
 * (so path canonicalization is deterministic regardless of what exists). */
async function makeRegistry(times: string[] = []): Promise<{
  registry: HomeRegistry;
  registryPath: string;
}> {
  const registryPath = await tempRegistryPath();
  let tick = 0;
  const registry = createHomeRegistry({
    registryPath,
    realpath: (path) => path,
    now: () =>
      new Date(
        times[Math.min(tick++, times.length - 1)] ?? '2026-01-01T00:00:00.000Z',
      ),
  });
  return { registry, registryPath };
}

describe('HomeRegistry store', () => {
  it('registers a Home and reads it back', async () => {
    const { registry } = await makeRegistry(['2026-06-01T00:00:00.000Z']);

    await registry.upsert('/homes/alpha');

    expect(await registry.read()).toEqual([
      { path: '/homes/alpha', lastSeenAt: '2026-06-01T00:00:00.000Z' },
    ]);
  });

  it('dedupes the same Home and refreshes lastSeenAt', async () => {
    const { registry } = await makeRegistry([
      '2026-06-01T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
    ]);

    await registry.upsert('/homes/alpha');
    await registry.upsert('/homes/alpha');

    expect(await registry.read()).toEqual([
      { path: '/homes/alpha', lastSeenAt: '2026-06-02T00:00:00.000Z' },
    ]);
  });

  it('reads newest-lastSeenAt first', async () => {
    const { registry } = await makeRegistry([
      '2026-06-01T00:00:00.000Z',
      '2026-06-03T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
    ]);

    await registry.upsert('/homes/old');
    await registry.upsert('/homes/newest');
    await registry.upsert('/homes/middle');

    expect((await registry.read()).map((entry) => entry.path)).toEqual([
      '/homes/newest',
      '/homes/middle',
      '/homes/old',
    ]);
  });

  it('forget removes an entry and reports it; an unknown Home is a no-op', async () => {
    const { registry } = await makeRegistry([
      '2026-06-01T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
    ]);
    await registry.upsert('/homes/alpha');
    await registry.upsert('/homes/beta');

    expect(await registry.forget('/homes/alpha')).toBe(true);
    expect((await registry.read()).map((entry) => entry.path)).toEqual([
      '/homes/beta',
    ]);

    expect(await registry.forget('/homes/does-not-exist')).toBe(false);
    expect((await registry.read()).map((entry) => entry.path)).toEqual([
      '/homes/beta',
    ]);
  });

  it('reads a missing registry file as empty', async () => {
    const { registry } = await makeRegistry();
    expect(await registry.read()).toEqual([]);
  });

  it('reads a corrupt registry file as empty (advisory, non-fatal)', async () => {
    const { registry, registryPath } = await makeRegistry([
      '2026-06-01T00:00:00.000Z',
    ]);
    await registry.upsert('/homes/alpha');
    // Clobber with invalid JSON; a lost registry must never throw.
    await registry.write([{ path: '/homes/alpha', lastSeenAt: 'x' }]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(registryPath, '{ not valid json', 'utf8');

    expect(await registry.read()).toEqual([]);
  });

  it('writes atomically and survives concurrent upserts without corruption', async () => {
    const { registry, registryPath } = await makeRegistry([
      '2026-06-01T00:00:00.000Z',
    ]);

    await Promise.all([
      registry.upsert('/homes/same'),
      registry.upsert('/homes/same'),
      registry.upsert('/homes/same'),
      registry.upsert('/homes/same'),
      registry.upsert('/homes/same'),
    ]);

    const raw = await readFile(registryPath, 'utf8');
    // Always valid JSON (temp+rename), trailing newline, and deduped to one.
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect((await registry.read()).map((entry) => entry.path)).toEqual([
      '/homes/same',
    ]);
  });

  it('keeps both Homes when distinct upserts are awaited in sequence', async () => {
    const { registry } = await makeRegistry([
      '2026-06-01T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
    ]);
    await registry.upsert('/homes/alpha');
    await registry.upsert('/homes/beta');

    expect((await registry.read()).map((entry) => entry.path).sort()).toEqual([
      '/homes/alpha',
      '/homes/beta',
    ]);
  });
});

describe('resolveHomeRegistryPath', () => {
  it('honors an absolute XDG_STATE_HOME', () => {
    expect(resolveHomeRegistryPath({ XDG_STATE_HOME: '/custom/state' })).toBe(
      '/custom/state/agent-tty/homes.json',
    );
  });

  it('ignores a relative XDG_STATE_HOME and falls back to ~/.local/state', () => {
    expect(resolveHomeRegistryPath({ XDG_STATE_HOME: 'relative/state' })).toBe(
      join(homedir(), '.local', 'state', 'agent-tty', 'homes.json'),
    );
  });

  it('defaults to ~/.local/state and is independent of AGENT_TTY_HOME', () => {
    const expected = join(
      homedir(),
      '.local',
      'state',
      'agent-tty',
      'homes.json',
    );
    expect(resolveHomeRegistryPath({})).toBe(expected);
    // The registry spans Homes, so AGENT_TTY_HOME must not relocate it.
    expect(resolveHomeRegistryPath({ AGENT_TTY_HOME: '/some/home' })).toBe(
      expected,
    );
  });
});

describe('normalizeHomePath', () => {
  it('resolves a relative path to absolute (identity realpath)', () => {
    expect(normalizeHomePath('/already/abs', (path) => path)).toBe(
      '/already/abs',
    );
    expect(normalizeHomePath('relative/sub', (path) => path)).toBe(
      join(process.cwd(), 'relative', 'sub'),
    );
  });
});
