import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import { writeTextFileAtomic } from './manifests.js';

const STATE_SUBDIRECTORY = 'agent-tty';
const REGISTRY_FILENAME = 'homes.json';
const REGISTRY_VERSION = 1;

/**
 * A single Home Registry entry: just the Home path and when it was last seen.
 * Session counts and statuses are derived live by scanning the Home, never
 * cached here (see `src/dashboard/homeScope.ts`).
 */
export interface HomeRegistryEntry {
  path: string;
  lastSeenAt: string;
}

const HomeRegistryEntrySchema = z
  .object({
    path: z.string().min(1),
    lastSeenAt: z.string().min(1),
  })
  .strict();

// Non-strict at the top level so a future field never makes an existing file
// unreadable; entries themselves are validated and bad ones drop out.
const HomeRegistryFileSchema = z.object({
  version: z.number(),
  homes: z.array(HomeRegistryEntrySchema),
});

/**
 * Resolve the per-machine Home Registry path. It is a function of the OS user
 * (`${XDG_STATE_HOME:-~/.local/state}/agent-tty/homes.json`) and deliberately
 * independent of `AGENT_TTY_HOME`: the registry spans Homes, so it cannot live
 * inside one. Per the XDG spec, a relative `XDG_STATE_HOME` is ignored.
 */
export function resolveHomeRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdgStateHome = env.XDG_STATE_HOME;
  const base =
    xdgStateHome !== undefined &&
    xdgStateHome.length > 0 &&
    isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(homedir(), '.local', 'state');

  const registryPath = normalize(
    join(base, STATE_SUBDIRECTORY, REGISTRY_FILENAME),
  );
  invariant(isAbsolute(registryPath), 'home registry path must be absolute');
  return registryPath;
}

/**
 * Normalize a Home path to the canonical form stored in the registry, matching
 * how `resolveHome`/`validateHomePath` canonicalize: resolve to absolute,
 * normalize, then realpath if the directory exists (so symlinks and `..`
 * collapse). A path whose directory is gone (a forgettable dead Home) falls
 * back to its normalized absolute form.
 */
export function normalizeHomePath(
  homePath: string,
  realpath: (path: string) => string = realpathSync,
): string {
  invariant(
    typeof homePath === 'string' && homePath.length > 0,
    'home path must be a non-empty string',
  );

  const absolute = isAbsolute(homePath) ? homePath : resolve(homePath);
  const normalized = normalize(absolute);
  try {
    return realpath(normalized);
  } catch {
    return normalized;
  }
}

export interface HomeRegistryDependencies {
  registryPath: string;
  readFile: (path: string) => Promise<string>;
  writeAtomic: (path: string, contents: string) => Promise<void>;
  realpath: (path: string) => string;
  now: () => Date;
}

function defaultDependencies(): HomeRegistryDependencies {
  return {
    registryPath: resolveHomeRegistryPath(),
    readFile: (path) => readFile(path, 'utf8'),
    writeAtomic: (path, contents) =>
      writeTextFileAtomic({
        path,
        pathLabel: 'home registry path',
        contents,
        writeErrorMessage: `Failed to write the Home Registry at ${path}.`,
      }),
    realpath: realpathSync,
    now: () => new Date(),
  };
}

export interface HomeRegistry {
  /** All entries, newest-`lastSeenAt`-first. Does not prune (that is a read-time
   * concern of the caller, which scans each Home); never throws on a missing or
   * corrupt file — an advisory registry behaves as empty and is rebuilt. */
  read(): Promise<HomeRegistryEntry[]>;
  /** Register a Home (or refresh its `lastSeenAt`). Atomic and idempotent. */
  upsert(homePath: string): Promise<void>;
  /** Remove a Home from the registry. Returns whether an entry was removed.
   * Never touches the Home directory on disk. */
  forget(homePath: string): Promise<boolean>;
  /** Replace the registry contents atomically. */
  write(entries: HomeRegistryEntry[]): Promise<void>;
}

function sortNewestFirst(entries: HomeRegistryEntry[]): HomeRegistryEntry[] {
  return [...entries].sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt),
  );
}

export function createHomeRegistry(
  overrides: Partial<HomeRegistryDependencies> = {},
): HomeRegistry {
  const deps = { ...defaultDependencies(), ...overrides };

  async function readRaw(): Promise<HomeRegistryEntry[]> {
    let raw: string;
    try {
      raw = await deps.readFile(deps.registryPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return [];
      }
      // Advisory store: an unreadable registry behaves as empty rather than
      // breaking discovery; it is rebuilt on the next create.
      return [];
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }

    const parsed = HomeRegistryFileSchema.safeParse(data);
    return parsed.success ? parsed.data.homes : [];
  }

  async function write(entries: HomeRegistryEntry[]): Promise<void> {
    const file = {
      version: REGISTRY_VERSION,
      homes: sortNewestFirst(entries),
    };
    await deps.writeAtomic(
      deps.registryPath,
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }

  return {
    async read() {
      return sortNewestFirst(await readRaw());
    },

    async upsert(homePath) {
      const key = normalizeHomePath(homePath, deps.realpath);
      const lastSeenAt = deps.now().toISOString();
      // Read immediately before write to keep the lost-update window small.
      // Concurrent creates can still race, but the atomic temp+rename keeps the
      // file from ever being corrupt, and a dropped entry re-registers next time.
      const existing = await readRaw();
      const filtered = existing.filter((entry) => entry.path !== key);
      filtered.unshift({ path: key, lastSeenAt });
      await write(filtered);
    },

    async forget(homePath) {
      const key = normalizeHomePath(homePath, deps.realpath);
      const existing = await readRaw();
      const filtered = existing.filter((entry) => entry.path !== key);
      if (filtered.length === existing.length) {
        return false;
      }
      await write(filtered);
      return true;
    },

    write,
  };
}

/** Convenience: register a Home using the default (real-fs) registry. */
export async function upsertHome(homePath: string): Promise<void> {
  await createHomeRegistry().upsert(homePath);
}

/** Convenience: forget a Home using the default (real-fs) registry. */
export async function forgetHome(homePath: string): Promise<boolean> {
  return createHomeRegistry().forget(homePath);
}

/** Convenience: read all registered Homes using the default (real-fs) registry. */
export async function readHomeRegistry(): Promise<HomeRegistryEntry[]> {
  return createHomeRegistry().read();
}
