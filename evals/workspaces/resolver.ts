/**
 * Merge order for workspace presets:
 * 1. Preset `env` is applied first; case/request env overrides are layered on top.
 * 2. Preset `bootstrap` commands run before any case-level `setup`.
 * 3. The `ResolvedWorkspacePlan` returned here is the reportable shape: env values for keys whose suffix (case-insensitive) matches `_TOKEN`, `_KEY`, `_SECRET`, or `_PASSWORD` are replaced with `"[REDACTED]"`. Runtime env must be obtained separately via `deriveEffectiveEnv`.
 */
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { assertString, invariant } from '../../src/util/assert.js';
import type { ResolvedWorkspacePlan, WorkspacePreset } from './types.js';

const REDACTED_ENV_VALUE = '[REDACTED]';
const SENSITIVE_ENV_KEY_SUFFIX_REGEX = /(?:_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;

type ResolveWorkspacePresetContext = {
  homeDir: string;
  repoRoot?: string;
};

function assertAbsolutePath(value: string, message: string): void {
  assertString(value, message);
  invariant(value.length > 0, message);
  invariant(isAbsolute(value), message);
}

function resolveTemplateDir(
  ctx: ResolveWorkspacePresetContext,
  preset: WorkspacePreset,
): string | undefined {
  if (preset.templateDir === undefined) {
    return undefined;
  }

  const templateDir = isAbsolute(preset.templateDir)
    ? preset.templateDir
    : (() => {
        if (ctx.repoRoot === undefined) {
          throw new Error(
            `Workspace preset "${preset.id}" uses relative templateDir "${preset.templateDir}" but ctx.repoRoot is required to resolve it.`,
          );
        }

        return resolve(ctx.repoRoot, preset.templateDir);
      })();

  try {
    const stats = statSync(templateDir);
    if (!stats.isDirectory()) {
      throw new Error(
        `Workspace preset "${preset.id}" templateDir "${templateDir}" is not a directory.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Workspace preset "${preset.id}" templateDir`)
    ) {
      throw error;
    }

    const details = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `Workspace preset "${preset.id}" templateDir "${templateDir}" does not exist or is not accessible${details}`,
      { cause: error },
    );
  }

  return templateDir;
}

function redactEnv(
  env: Record<string, string> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined) {
    return undefined;
  }

  const redactedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redactedEnv[key] = SENSITIVE_ENV_KEY_SUFFIX_REGEX.test(key)
      ? REDACTED_ENV_VALUE
      : value;
  }

  return redactedEnv;
}

function normalizeBootstrap(
  preset: WorkspacePreset,
): ResolvedWorkspacePlan['bootstrap'] {
  return (preset.bootstrap ?? []).map((step) => ({
    command: step.command,
    args: step.args === undefined ? [] : [...step.args],
    ...(step.description === undefined
      ? {}
      : { description: step.description }),
  }));
}

export function resolveWorkspacePreset(
  ctx: ResolveWorkspacePresetContext,
  preset: WorkspacePreset,
): ResolvedWorkspacePlan {
  assertAbsolutePath(ctx.homeDir, 'ctx.homeDir must be an absolute path');
  if (ctx.repoRoot !== undefined) {
    assertAbsolutePath(ctx.repoRoot, 'ctx.repoRoot must be an absolute path');
  }

  const templateDir = resolveTemplateDir(ctx, preset);
  const cwd =
    preset.cwd === undefined
      ? undefined
      : isAbsolute(preset.cwd)
        ? preset.cwd
        : resolve(ctx.homeDir, preset.cwd);
  const bootstrap = normalizeBootstrap(preset);

  const redactedEnv = redactEnv(preset.env);

  return {
    presetId: preset.id,
    mode: preset.mode,
    description: preset.description,
    ...(templateDir === undefined ? {} : { templateDir }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(redactedEnv === undefined ? {} : { env: redactedEnv }),
    bootstrap,
    bootstrapCount: bootstrap.length,
  };
}

/**
 * Returns raw values (no redaction) for runtime spawn use only. Never serialize or log the result.
 */
export function deriveEffectiveEnv(
  preset: WorkspacePreset,
  overrides?: Record<string, string>,
): Record<string, string> {
  return {
    ...(preset.env ?? {}),
    ...(overrides ?? {}),
  };
}
