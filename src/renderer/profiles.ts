import type { ZodError } from 'zod';

import { invariant } from '../util/assert.js';
import {
  RenderProfileConfigSchema,
  type RenderProfileConfig,
} from './types.js';

export const BUILTIN_PROFILE_NAMES = Object.freeze([
  'reference-dark',
  'reference-light',
] as const);

type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number];

const BUILTIN_PROFILES: Record<BuiltinProfileName, RenderProfileConfig> = {
  'reference-dark': {
    name: 'reference-dark',
    theme: 'dark',
    fontFamily: 'monospace',
    fontSize: 14,
    cursorStyle: 'block',
    backgroundColor: '#1e1e2e',
    foregroundColor: '#cdd6f4',
  },
  'reference-light': {
    name: 'reference-light',
    theme: 'light',
    fontFamily: 'monospace',
    fontSize: 14,
    cursorStyle: 'block',
    backgroundColor: '#eff1f5',
    foregroundColor: '#4c4f69',
  },
};

function formatSchemaIssues(error: ZodError<RenderProfileConfig>): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function assertRenderProfileConfig(
  config: unknown,
): asserts config is RenderProfileConfig {
  const result = RenderProfileConfigSchema.safeParse(config);
  if (!result.success) {
    invariant(false, formatSchemaIssues(result.error));
  }

  const validatedConfig = result.data;
  invariant(
    validatedConfig.name.length > 0,
    'render profile name must be non-empty',
  );
  invariant(
    validatedConfig.fontSize > 0,
    'render profile fontSize must be positive',
  );
  invariant(
    /^#[0-9a-fA-F]{6}$/u.test(validatedConfig.backgroundColor),
    'render profile backgroundColor must be a hex color',
  );
  invariant(
    /^#[0-9a-fA-F]{6}$/u.test(validatedConfig.foregroundColor),
    'render profile foregroundColor must be a hex color',
  );
}

function isBuiltinProfileName(name: string): name is BuiltinProfileName {
  return Object.hasOwn(BUILTIN_PROFILES, name);
}

for (const profileName of BUILTIN_PROFILE_NAMES) {
  invariant(
    profileName.length > 0,
    'builtin render profile name must be non-empty',
  );
  assertRenderProfileConfig(BUILTIN_PROFILES[profileName]);
}

function cloneProfile(profile: RenderProfileConfig): RenderProfileConfig {
  return { ...profile };
}

export function getBuiltinProfile(
  name: string,
): RenderProfileConfig | undefined {
  invariant(name.length > 0, 'profile name must be a non-empty string');

  const profile = isBuiltinProfileName(name)
    ? BUILTIN_PROFILES[name]
    : undefined;
  return profile === undefined ? undefined : cloneProfile(profile);
}

export function resolveProfile(
  nameOrConfig: string | RenderProfileConfig,
): RenderProfileConfig {
  if (typeof nameOrConfig === 'string') {
    invariant(nameOrConfig.length > 0, 'profile name must be a non-empty string');

    const builtinProfile = getBuiltinProfile(nameOrConfig);
    invariant(
      builtinProfile !== undefined,
      `unknown render profile: ${nameOrConfig}`,
    );
    return builtinProfile;
  }

  assertRenderProfileConfig(nameOrConfig);
  return cloneProfile(nameOrConfig);
}
