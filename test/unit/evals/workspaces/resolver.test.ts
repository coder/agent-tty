import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveEffectiveEnv,
  resolveWorkspacePreset,
} from '../../../../evals/workspaces/resolver.js';
import type { WorkspacePreset } from '../../../../evals/workspaces/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atty-ws-resolver-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function createPreset(
  overrides: Partial<WorkspacePreset> = {},
): WorkspacePreset {
  return {
    id: 'resolver-preset',
    mode: 'isolated',
    description: 'Resolver test preset',
    ...overrides,
  };
}

describe('resolveWorkspacePreset', () => {
  it('throws when templateDir does not exist and names the preset id and path', () => {
    const homeDir = createTempDir();
    const missingTemplateDir = path.join(homeDir, 'missing-template');
    const preset = createPreset({
      id: 'missing-template',
      templateDir: missingTemplateDir,
    });

    const resolvePreset = () => resolveWorkspacePreset({ homeDir }, preset);

    expect(resolvePreset).toThrow(`Workspace preset "${preset.id}"`);
    expect(resolvePreset).toThrow(missingTemplateDir);
  });

  it('throws when templateDir points at a file instead of a directory', () => {
    const homeDir = createTempDir();
    const templateFile = path.join(homeDir, 'template.txt');
    fs.writeFileSync(templateFile, 'not a directory');
    const preset = createPreset({
      id: 'file-template',
      templateDir: templateFile,
    });

    expect(() => resolveWorkspacePreset({ homeDir }, preset)).toThrow(
      `Workspace preset "${preset.id}" templateDir "${templateFile}" is not a directory.`,
    );
  });

  it('redacts secret-like env keys with a case-insensitive suffix match', () => {
    const homeDir = createTempDir();
    const plan = resolveWorkspacePreset(
      { homeDir },
      createPreset({
        id: 'redacted-env',
        env: {
          API_TOKEN: 's1',
          api_key: 's2',
          Database_Password: 's3',
          MY_SECRET: 's4',
          FOO_BAR: 'ok',
        },
      }),
    );

    expect(plan.env).toEqual({
      API_TOKEN: '[REDACTED]',
      api_key: '[REDACTED]',
      Database_Password: '[REDACTED]',
      MY_SECRET: '[REDACTED]',
      FOO_BAR: 'ok',
    });
  });

  it('omits cwd when absent and preserves absolute or home-relative cwd values', () => {
    const homeDir = createTempDir();
    const absoluteCwd = path.join(homeDir, 'absolute-cwd');

    const omittedCwdPlan = resolveWorkspacePreset(
      { homeDir },
      createPreset({ id: 'cwd-omitted' }),
    );
    const absoluteCwdPlan = resolveWorkspacePreset(
      { homeDir },
      createPreset({ id: 'cwd-absolute', cwd: absoluteCwd }),
    );
    const relativeCwdPlan = resolveWorkspacePreset(
      { homeDir },
      createPreset({ id: 'cwd-relative', cwd: './work' }),
    );

    expect(omittedCwdPlan).not.toHaveProperty('cwd');
    expect(absoluteCwdPlan.cwd).toBe(absoluteCwd);
    expect(relativeCwdPlan.cwd).toBe(path.resolve(homeDir, './work'));
  });

  it('normalizes bootstrap args and counts bootstrap steps', () => {
    const homeDir = createTempDir();
    const plan = resolveWorkspacePreset(
      { homeDir },
      createPreset({
        id: 'bootstrap-normalization',
        bootstrap: [{ command: 'node' }],
      }),
    );

    expect(plan.bootstrap).toEqual([{ command: 'node', args: [] }]);
    expect(plan.bootstrapCount).toBe(1);
  });

  it('never serializes raw secret env values into the resolved plan', () => {
    const homeDir = createTempDir();
    const secretValue = 'super-secret-value';
    const planJson = JSON.stringify(
      resolveWorkspacePreset(
        { homeDir },
        createPreset({
          id: 'secret-invariant',
          env: { API_TOKEN: secretValue },
        }),
      ),
    );

    expect(planJson).not.toContain(secretValue);
    expect(planJson).toContain('[REDACTED]');
  });
});

describe('deriveEffectiveEnv', () => {
  it('merges preset env first, applies overrides on top, and preserves raw secret values', () => {
    const preset = createPreset({
      id: 'effective-env',
      env: {
        API_TOKEN: 'super-secret-value',
        SHARED: 'preset-value',
        KEEP: 'keep-me',
      },
    });

    expect(
      deriveEffectiveEnv(preset, {
        SHARED: 'override-value',
        EXTRA: 'extra-value',
      }),
    ).toEqual({
      API_TOKEN: 'super-secret-value',
      SHARED: 'override-value',
      KEEP: 'keep-me',
      EXTRA: 'extra-value',
    });
  });
});
