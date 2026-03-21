import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PROFILE_NAMES,
  getBuiltinProfile,
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

    expect(profile).toEqual({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    });

    expect(profile).not.toBeUndefined();

    const secondRead = getBuiltinProfile('reference-dark');
    expect(secondRead).not.toBeUndefined();

    if (profile === undefined || secondRead === undefined) {
      throw new Error('expected reference-dark to be available');
    }

    profile.fontFamily = 'mutated';

    expect(secondRead.fontFamily).toBe('monospace');
  });

  it('resolves built-in and custom profiles', () => {
    expect(resolveProfile('reference-dark')).toEqual({
      name: 'reference-dark',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#1e1e2e',
      foregroundColor: '#cdd6f4',
    });

    expect(
      resolveProfile({
        name: 'custom',
        theme: 'light',
        fontFamily: 'monospace',
        fontSize: 16,
        cursorStyle: 'underline',
        backgroundColor: '#ffffff',
        foregroundColor: '#000000',
      }),
    ).toEqual({
      name: 'custom',
      theme: 'light',
      fontFamily: 'monospace',
      fontSize: 16,
      cursorStyle: 'underline',
      backgroundColor: '#ffffff',
      foregroundColor: '#000000',
    });
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
