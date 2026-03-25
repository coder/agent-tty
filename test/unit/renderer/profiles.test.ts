import { AssertionError } from 'node:assert';

import { describe, expect, it } from 'vitest';

import { BUNDLED_FONT_FAMILY } from '../../../src/renderer/bundledFont.js';
import {
  BUILTIN_PROFILE_NAMES,
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

    expect(profile).toMatchObject({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: BUNDLED_FONT_FAMILY,
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    });
    expect(profile?.fontAssetIdentity).toMatch(/^[a-f0-9]{64}$/u);

    expect(profile).not.toBeUndefined();

    const secondRead = getBuiltinProfile('reference-dark');
    expect(secondRead).not.toBeUndefined();

    if (profile === undefined || secondRead === undefined) {
      throw new Error('expected reference-dark to be available');
    }

    profile.fontFamily = 'mutated';
    profile.fontAssetIdentity = 'a'.repeat(64);

    expect(secondRead.fontFamily).toBe(BUNDLED_FONT_FAMILY);
    expect(secondRead.fontAssetIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondRead.fontAssetIdentity).not.toBe('a'.repeat(64));
  });

  it('uses the bundled JetBrains Mono font for built-in profiles', () => {
    for (const profileName of BUILTIN_PROFILE_NAMES) {
      const profile = resolveProfile(profileName);

      expect(profile.fontFamily).toBe(BUNDLED_FONT_FAMILY);
      expect(profile.fontAssetIdentity).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it('resolves built-in and custom profiles without a font asset identity', () => {
    expect(resolveProfile('reference-dark')).toMatchObject({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: BUNDLED_FONT_FAMILY,
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    });
    expect(resolveProfile('reference-dark').fontAssetIdentity).toMatch(
      /^[a-f0-9]{64}$/u,
    );

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
  });

  it('hashes profiles deterministically as lowercase SHA-256 hex', () => {
    const profile = resolveProfile('reference-dark');
    const firstHash = hashProfile(profile);
    const secondHash = hashProfile(profile);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('changes the hash when only fontAssetIdentity changes', () => {
    const baseProfile = {
      name: 'custom',
      theme: 'dark',
      fontFamily: BUNDLED_FONT_FAMILY,
      fontAssetIdentity: '1'.repeat(64),
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    } as const;

    expect(hashProfile(baseProfile)).not.toBe(
      hashProfile({
        ...baseProfile,
        fontAssetIdentity: '2'.repeat(64),
      }),
    );
  });

  it('keeps the hash stable when fontAssetIdentity is unchanged', () => {
    const profile = {
      name: 'custom',
      theme: 'dark',
      fontFamily: BUNDLED_FONT_FAMILY,
      fontAssetIdentity: '3'.repeat(64),
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    } as const;

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
