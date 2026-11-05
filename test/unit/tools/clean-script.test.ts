import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function buildInfoFiles(): string[] {
  return ['tsconfig.json', 'tsconfig.build.json'].map((name) => {
    const text = readFileSync(join(repoRoot, name), 'utf8');
    const file = /"tsBuildInfoFile":\s*"([^"]+)"/.exec(text)?.[1];
    if (file === undefined) {
      throw new Error(`${name} names no tsBuildInfoFile`);
    }
    return file;
  });
}

describe('npm run clean', () => {
  // A build info file that survives `clean` makes the next `tsc -p` build
  // skip its output, so `clean` then `build` would leave dist/ empty.
  it('removes dist, coverage and every build info file the tsconfigs name', async () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const script = pkg.scripts.clean;
    if (script === undefined) {
      throw new Error('package.json has no clean script');
    }

    const dir = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-clean-')),
    );
    tempDirs.push(dir);
    const targets = [
      'dist/cli/main.js',
      'coverage/index.html',
      ...buildInfoFiles(),
    ];
    for (const target of targets) {
      await mkdir(join(dir, target, '..'), { recursive: true });
      await writeFile(join(dir, target), 'stale');
    }

    execFileSync('sh', ['-c', script], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${join(repoRoot, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
    });

    for (const target of ['dist', 'coverage', ...buildInfoFiles()]) {
      expect(existsSync(join(dir, target)), `${target} removed`).toBe(false);
    }
  });
});
