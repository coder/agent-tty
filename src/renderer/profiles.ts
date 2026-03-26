import { createHash } from 'node:crypto';

import type { ZodError } from 'zod';

import { invariant } from '../util/assert.js';
import {
  BUNDLED_FONT_ASSET_IDENTITY,
  BUNDLED_FONT_FAMILY,
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_FAMILY,
  getBundledFontAssetByIdentity,
} from './bundledFont.js';
import {
  RenderProfileConfigSchema,
  type RenderProfileBundledFont,
  type RenderProfileConfig,
} from './types.js';

export const BUILTIN_PROFILE_NAMES = Object.freeze([
  'reference-dark',
  'reference-light',
] as const);

export const REFERENCE_PROFILE_FONT_STACK = `"${BUNDLED_FONT_FAMILY}", "${BUNDLED_SYMBOLS_FONT_FAMILY}", monospace`;

type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number];

function createBundledFontDescriptor(
  family: string,
  assetIdentity: string,
  route: string,
  weight: string,
  style: 'italic' | 'normal' | 'oblique',
): RenderProfileBundledFont {
  return Object.freeze({
    assetIdentity,
    family,
    route,
    style,
    weight,
  });
}

const BUILTIN_PROFILE_FONT_ASSETS = Object.freeze([
  createBundledFontDescriptor(
    BUNDLED_PRIMARY_FONT_ASSET.family,
    BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
    BUNDLED_PRIMARY_FONT_ASSET.route,
    BUNDLED_PRIMARY_FONT_ASSET.weight,
    BUNDLED_PRIMARY_FONT_ASSET.style,
  ),
  createBundledFontDescriptor(
    BUNDLED_SYMBOLS_FONT_ASSET.family,
    BUNDLED_SYMBOLS_FONT_ASSET.assetIdentity,
    BUNDLED_SYMBOLS_FONT_ASSET.route,
    BUNDLED_SYMBOLS_FONT_ASSET.weight,
    BUNDLED_SYMBOLS_FONT_ASSET.style,
  ),
] as const satisfies readonly RenderProfileBundledFont[]);

const BUILTIN_PROFILES: Record<BuiltinProfileName, RenderProfileConfig> = {
  'reference-dark': {
    name: 'reference-dark',
    theme: 'dark',
    fontFamily: REFERENCE_PROFILE_FONT_STACK,
    fontAssetIdentity: BUNDLED_FONT_ASSET_IDENTITY,
    fontAssets: [...BUILTIN_PROFILE_FONT_ASSETS],
    fontSize: 14,
    cursorStyle: 'block',
    backgroundColor: '#1e1e2e',
    foregroundColor: '#cdd6f4',
  },
  'reference-light': {
    name: 'reference-light',
    theme: 'light',
    fontFamily: REFERENCE_PROFILE_FONT_STACK,
    fontAssetIdentity: BUNDLED_FONT_ASSET_IDENTITY,
    fontAssets: [...BUILTIN_PROFILE_FONT_ASSETS],
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

function assertBundledFontDescriptor(
  fontAsset: RenderProfileBundledFont,
  label: string,
): void {
  const bundledAsset = getBundledFontAssetByIdentity(fontAsset.assetIdentity);
  invariant(
    bundledAsset !== undefined,
    `${label} assetIdentity must reference a bundled font asset`,
  );
  invariant(
    bundledAsset.route === fontAsset.route,
    `${label} route must match the bundled font asset route`,
  );
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
  if (validatedConfig.fontAssetIdentity !== undefined) {
    invariant(
      getBundledFontAssetByIdentity(validatedConfig.fontAssetIdentity) !==
        undefined,
      'render profile fontAssetIdentity must reference a bundled font asset',
    );
  }
  for (const [index, fontAsset] of (
    validatedConfig.fontAssets ?? []
  ).entries()) {
    assertBundledFontDescriptor(
      fontAsset,
      `render profile fontAssets.${String(index)}`,
    );
  }
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

function cloneBundledFontDescriptor(
  fontAsset: RenderProfileBundledFont,
): RenderProfileBundledFont {
  return { ...fontAsset };
}

function cloneProfile(profile: RenderProfileConfig): RenderProfileConfig {
  return {
    ...profile,
    ...(profile.fontAssets !== undefined
      ? { fontAssets: profile.fontAssets.map(cloneBundledFontDescriptor) }
      : {}),
  };
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

export function hashProfile(config: RenderProfileConfig): string {
  assertRenderProfileConfig(config);

  const canonicalConfig = {
    name: config.name,
    theme: config.theme,
    fontFamily: config.fontFamily,
    fontAssetIdentity: config.fontAssetIdentity ?? null,
    fontAssets:
      config.fontAssets?.map((fontAsset) => ({
        assetIdentity: fontAsset.assetIdentity,
        family: fontAsset.family,
        route: fontAsset.route,
        style: fontAsset.style,
        weight: fontAsset.weight,
      })) ?? null,
    fontSize: config.fontSize,
    cursorStyle: config.cursorStyle,
    backgroundColor: config.backgroundColor,
    foregroundColor: config.foregroundColor,
  };
  const hash = createHash('sha256')
    .update(JSON.stringify(canonicalConfig))
    .digest('hex');

  invariant(
    /^[a-f0-9]{64}$/u.test(hash),
    'render profile hash must be a 64-character lowercase SHA-256 hex string',
  );

  return hash;
}

export function resolveProfile(
  nameOrConfig: string | RenderProfileConfig,
): RenderProfileConfig {
  if (typeof nameOrConfig === 'string') {
    invariant(
      nameOrConfig.length > 0,
      'profile name must be a non-empty string',
    );

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
