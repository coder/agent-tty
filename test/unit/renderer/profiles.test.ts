import { AssertionError } from 'node:assert';

import { describe, expect, it } from 'vitest';

import {
  BUNDLED_FONT_FAMILY,
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
} from '../../../src/renderer/bundledFont.js';
import {
  BUILTIN_PROFILE_NAMES,
  REFERENCE_PROFILE_FONT_STACK,
  getBuiltinProfile,
  hashProfile,
  resolveProfile,
} from '../../../src/renderer/profiles.js';

describe('renderer profiles', () => {
  it('exposes the built-in reference profiles', () => {
    expect(BUILTIN_PROFILE_NAMES).toEqual([
      'reference-dark',
      'reference-light',
    ]);
  });

  it('returns cloned built-in profiles by name', () => {
    const profile = getBuiltinProfile('reference-dark');
    const secondRead = getBuiltinProfile('reference-dark');

    expect(profile).not.toBeUndefined();
    expect(secondRead).not.toBeUndefined();
    if (profile === undefined || secondRead === undefined) {
      throw new Error('expected reference-dark to be available');
    }

    expect(profile).toMatchObject({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: REFERENCE_PROFILE_FONT_STACK,
      fontAssetIdentity: BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    });
    expect(profile.fontAssets).toEqual([
      {
        family: BUNDLED_PRIMARY_FONT_ASSET.family,
        assetIdentity: BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
        route: BUNDLED_PRIMARY_FONT_ASSET.route,
        weight: BUNDLED_PRIMARY_FONT_ASSET.weight,
        style: BUNDLED_PRIMARY_FONT_ASSET.style,
      },
      {
        family: BUNDLED_SYMBOLS_FONT_ASSET.family,
        assetIdentity: BUNDLED_SYMBOLS_FONT_ASSET.assetIdentity,
        route: BUNDLED_SYMBOLS_FONT_ASSET.route,
        weight: BUNDLED_SYMBOLS_FONT_ASSET.weight,
        style: BUNDLED_SYMBOLS_FONT_ASSET.style,
      },
    ]);

    profile.fontFamily = 'mutated';
    profile.fontAssetIdentity = BUNDLED_SYMBOLS_FONT_ASSET.assetIdentity;
    if (profile.fontAssets?.[0] !== undefined) {
      profile.fontAssets[0].family = 'mutated primary';
    }

    expect(secondRead.fontFamily).toBe(REFERENCE_PROFILE_FONT_STACK);
    expect(secondRead.fontAssetIdentity).toBe(
      BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
    );
    expect(secondRead.fontAssets?.[0]?.family).toBe(BUNDLED_FONT_FAMILY);
  });

  it('uses the bundled font stack for built-in profiles', () => {
    for (const profileName of BUILTIN_PROFILE_NAMES) {
      const profile = resolveProfile(profileName);

      expect(profile.fontFamily).toBe(REFERENCE_PROFILE_FONT_STACK);
      expect(profile.fontAssetIdentity).toBe(
        BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
      );
      expect(
        profile.fontAssets?.map((fontAsset) => fontAsset.assetIdentity),
      ).toEqual([
        BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
        BUNDLED_SYMBOLS_FONT_ASSET.assetIdentity,
      ]);
    }
  });

  it('resolves built-in and custom profiles without bundled font metadata', () => {
    expect(resolveProfile('reference-dark')).toMatchObject({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: REFERENCE_PROFILE_FONT_STACK,
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    });
    expect(resolveProfile('reference-dark').fontAssets).toHaveLength(2);

    const customProfile = resolveProfile({
      name: 'custom',
      theme: 'light',
      fontFamily: 'monospace',
      fontSize: 16,
      cursorStyle: 'underline',
      backgroundColor: '#ffffff',
      foregroundColor: '#000000',
    });

    expect(customProfile).toEqual({
      name: 'custom',
      theme: 'light',
      fontFamily: 'monospace',
      fontSize: 16,
      cursorStyle: 'underline',
      backgroundColor: '#ffffff',
      foregroundColor: '#000000',
    });
    expect(customProfile).not.toHaveProperty('fontAssetIdentity');
    expect(customProfile).not.toHaveProperty('fontAssets');
  });

  it('hashes profiles deterministically as lowercase SHA-256 hex', () => {
    const profile = resolveProfile('reference-dark');
    const firstHash = hashProfile(profile);
    const secondHash = hashProfile(profile);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('changes the hash when bundled font ordering changes', () => {
    const baseProfile: Parameters<typeof hashProfile>[0] = {
      name: 'custom',
      theme: 'dark',
      fontFamily: REFERENCE_PROFILE_FONT_STACK,
      fontAssets: [
        {
          family: BUNDLED_PRIMARY_FONT_ASSET.family,
          assetIdentity: BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
          route: BUNDLED_PRIMARY_FONT_ASSET.route,
          style: BUNDLED_PRIMARY_FONT_ASSET.style,
          weight: BUNDLED_PRIMARY_FONT_ASSET.weight,
        },
        {
          family: BUNDLED_SYMBOLS_FONT_ASSET.family,
          assetIdentity: BUNDLED_SYMBOLS_FONT_ASSET.assetIdentity,
          route: BUNDLED_SYMBOLS_FONT_ASSET.route,
          style: BUNDLED_SYMBOLS_FONT_ASSET.style,
          weight: BUNDLED_SYMBOLS_FONT_ASSET.weight,
        },
      ],
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    };

    expect(hashProfile(baseProfile)).not.toBe(
      hashProfile({
        ...baseProfile,
        fontAssets: [...(baseProfile.fontAssets ?? [])].reverse(),
      }),
    );
  });

  it('keeps the hash stable when bundled font metadata is unchanged', () => {
    const profile: Parameters<typeof hashProfile>[0] = {
      name: 'custom',
      theme: 'dark',
      fontFamily: REFERENCE_PROFILE_FONT_STACK,
      fontAssets: [
        {
          family: BUNDLED_PRIMARY_FONT_ASSET.family,
          assetIdentity: BUNDLED_PRIMARY_FONT_ASSET.assetIdentity,
          route: BUNDLED_PRIMARY_FONT_ASSET.route,
          style: BUNDLED_PRIMARY_FONT_ASSET.style,
          weight: BUNDLED_PRIMARY_FONT_ASSET.weight,
        },
      ],
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    };

    expect(hashProfile(profile)).toBe(hashProfile({ ...profile }));
  });

  it('produces distinct hashes for different built-in profiles', () => {
    const darkProfile = resolveProfile('reference-dark');
    const lightProfile = resolveProfile('reference-light');

    expect(hashProfile(darkProfile)).not.toBe(hashProfile(lightProfile));
  });

  it('throws assertion errors for invalid profile configs', () => {
    const invalidProfile = {
      name: 'broken',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 0,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    } as Parameters<typeof hashProfile>[0];

    expect(() => hashProfile(invalidProfile)).toThrow(AssertionError);
    expect(() => hashProfile(invalidProfile)).toThrow(/Too small/u);
  });

  it('rejects unbundled font asset identities in profile metadata', () => {
    expect(() =>
      resolveProfile({
        name: 'broken-font-assets',
        theme: 'dark',
        fontFamily: REFERENCE_PROFILE_FONT_STACK,
        fontAssets: [
          {
            family: BUNDLED_FONT_FAMILY,
            assetIdentity: 'a'.repeat(64),
            route: BUNDLED_PRIMARY_FONT_ASSET.route,
            style: 'normal',
            weight: '400',
          },
        ],
        fontSize: 14,
        cursorStyle: 'block',
        backgroundColor: '#1e1e2e',
        foregroundColor: '#cdd6f4',
      }),
    ).toThrow(/assetIdentity must reference a bundled font asset/u);
  });

  it('throws clearly for unknown or invalid profiles', () => {
    expect(() => resolveProfile('nonexistent')).toThrow(
      /unknown render profile: nonexistent/u,
    );
    expect(() => resolveProfile('')).toThrow(
      /profile name must be a non-empty string/u,
    );
    expect(() =>
      resolveProfile({
        name: 'broken',
        theme: 'dark',
        fontFamily: 'monospace',
        fontSize: 0,
        cursorStyle: 'block',
        backgroundColor: '#1e1e2e',
        foregroundColor: '#cdd6f4',
      }),
    ).toThrow(/Too small/u);
  });
});
