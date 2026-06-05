import { describe, expect, it } from 'vitest';

import {
  assertValidKeyName,
  encodeKey,
  isValidKeyName,
} from '../../../src/pty/keyEncoder.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';

describe('encodeKey', () => {
  it('encodes Enter', () => {
    expect(encodeKey('Enter')).toBe('\r');
  });

  it('encodes Tab', () => {
    expect(encodeKey('Tab')).toBe('\t');
  });

  it('encodes Escape', () => {
    expect(encodeKey('Escape')).toBe('\x1b');
  });

  it('encodes Backspace', () => {
    expect(encodeKey('Backspace')).toBe('\x7f');
  });

  it('encodes Space', () => {
    expect(encodeKey('Space')).toBe(' ');
  });

  it('encodes ctrl+c', () => {
    expect(encodeKey('ctrl+c')).toBe('\x03');
  });

  it('encodes ctrl+a', () => {
    expect(encodeKey('ctrl+a')).toBe('\x01');
  });

  it('encodes ctrl+z', () => {
    expect(encodeKey('ctrl+z')).toBe('\x1a');
  });

  it('encodes ctrl+C case-insensitively', () => {
    expect(encodeKey('ctrl+C')).toBe('\x03');
  });

  it('encodes alt+x', () => {
    expect(encodeKey('alt+x')).toBe('\x1bx');
  });

  it('encodes Up', () => {
    expect(encodeKey('Up')).toBe('\x1b[A');
  });

  it('encodes Down', () => {
    expect(encodeKey('Down')).toBe('\x1b[B');
  });

  it('encodes Right', () => {
    expect(encodeKey('Right')).toBe('\x1b[C');
  });

  it('encodes Left', () => {
    expect(encodeKey('Left')).toBe('\x1b[D');
  });

  it('encodes shift+Up', () => {
    expect(encodeKey('shift+Up')).toBe('\x1b[1;2A');
  });

  it('encodes ctrl+Up', () => {
    expect(encodeKey('ctrl+Up')).toBe('\x1b[1;5A');
  });

  it('encodes ctrl+shift+Up', () => {
    expect(encodeKey('ctrl+shift+Up')).toBe('\x1b[1;6A');
  });

  it('encodes alt+Up', () => {
    expect(encodeKey('alt+Up')).toBe('\x1b[1;3A');
  });

  it('encodes F1', () => {
    expect(encodeKey('F1')).toBe('\x1bOP');
  });

  it('encodes F2', () => {
    expect(encodeKey('F2')).toBe('\x1bOQ');
  });

  it('encodes F3', () => {
    expect(encodeKey('F3')).toBe('\x1bOR');
  });

  it('encodes F4', () => {
    expect(encodeKey('F4')).toBe('\x1bOS');
  });

  it('encodes F5', () => {
    expect(encodeKey('F5')).toBe('\x1b[15~');
  });

  it('encodes F12', () => {
    expect(encodeKey('F12')).toBe('\x1b[24~');
  });

  it('encodes Home', () => {
    expect(encodeKey('Home')).toBe('\x1b[H');
  });

  it('encodes End', () => {
    expect(encodeKey('End')).toBe('\x1b[F');
  });

  it('encodes Delete', () => {
    expect(encodeKey('Delete')).toBe('\x1b[3~');
  });

  it('encodes Insert', () => {
    expect(encodeKey('Insert')).toBe('\x1b[2~');
  });

  it('encodes PageUp', () => {
    expect(encodeKey('PageUp')).toBe('\x1b[5~');
  });

  it('encodes PageDown', () => {
    expect(encodeKey('PageDown')).toBe('\x1b[6~');
  });

  it('encodes single char a', () => {
    expect(encodeKey('a')).toBe('a');
  });

  it('encodes single char Z', () => {
    expect(encodeKey('Z')).toBe('Z');
  });

  it('throws on an unknown key', () => {
    expect(() => encodeKey('BOGUS')).toThrow();
  });

  it('throws on an empty string', () => {
    expect(() => encodeKey('')).toThrow();
  });

  it('throws on a duplicate modifier', () => {
    expect(() => encodeKey('ctrl+ctrl+a')).toThrow();
  });
});

describe('isValidKeyName', () => {
  const validKeys = ['Enter', 'Escape', 'Space', 'ctrl+c', 'F12', 'Up', 'a'];
  const invalidKeys = ['BOGUS', '', 'ctrl+ctrl+a', 'ctrl+Enter'];

  it.each(validKeys)('agrees with encodeKey for valid key %s', (key) => {
    expect(() => encodeKey(key)).not.toThrow();
    expect(isValidKeyName(key)).toBe(true);
  });

  it.each(invalidKeys)('agrees with encodeKey for invalid key %s', (key) => {
    expect(() => encodeKey(key)).toThrow();
    expect(isValidKeyName(key)).toBe(false);
  });
});

describe('assertValidKeyName', () => {
  it('returns for a valid key name', () => {
    expect(() => assertValidKeyName('ctrl+c')).not.toThrow();
  });

  it('throws INVALID_KEYS for an invalid key name', () => {
    expect(() => assertValidKeyName('BOGUS')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_KEYS }),
    );
  });
});
