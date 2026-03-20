import { invariant } from '../util/assert.js';

interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

interface CsiFinalKeySpec {
  unmodified: string;
  final: string;
}

const SIMPLE_KEY_ENCODINGS = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
} as const;

const CSI_FINAL_KEY_ENCODINGS: Record<string, CsiFinalKeySpec> = {
  up: { unmodified: '\x1b[A', final: 'A' },
  down: { unmodified: '\x1b[B', final: 'B' },
  right: { unmodified: '\x1b[C', final: 'C' },
  left: { unmodified: '\x1b[D', final: 'D' },
  home: { unmodified: '\x1b[H', final: 'H' },
  end: { unmodified: '\x1b[F', final: 'F' },
  f1: { unmodified: '\x1bOP', final: 'P' },
  f2: { unmodified: '\x1bOQ', final: 'Q' },
  f3: { unmodified: '\x1bOR', final: 'R' },
  f4: { unmodified: '\x1bOS', final: 'S' },
};

const CSI_TILDE_KEY_ENCODINGS: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageup: 5,
  pagedown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};

const PRINTABLE_ASCII = /^[\x20-\x7e]$/;
const ASCII_LETTER = /^[A-Za-z]$/;

export function encodeKey(keyName: string): string {
  invariant(typeof keyName === 'string', 'Key name must be a string');

  const { baseKey, modifiers } = parseKeyName(keyName);
  const lowerBaseKey = baseKey.toLowerCase();

  if (lowerBaseKey === 'space') {
    return encodePrintableCharacter(' ', modifiers, baseKey);
  }

  if (Object.hasOwn(SIMPLE_KEY_ENCODINGS, lowerBaseKey)) {
    const simpleKey =
      SIMPLE_KEY_ENCODINGS[lowerBaseKey as keyof typeof SIMPLE_KEY_ENCODINGS];
    return encodeSimpleKey(lowerBaseKey, simpleKey, modifiers);
  }

  const csiFinalKey = CSI_FINAL_KEY_ENCODINGS[lowerBaseKey];
  if (csiFinalKey !== undefined) {
    return encodeCsiFinalKey(csiFinalKey, modifiers);
  }

  const csiTildeKeyCode = CSI_TILDE_KEY_ENCODINGS[lowerBaseKey];
  if (csiTildeKeyCode !== undefined) {
    return encodeCsiTildeKey(csiTildeKeyCode, modifiers);
  }

  if (baseKey.length === 1 && PRINTABLE_ASCII.test(baseKey)) {
    return encodePrintableCharacter(baseKey, modifiers, baseKey);
  }

  invariant(false, `Unknown base key: ${baseKey}`);
}

function parseKeyName(keyName: string): {
  baseKey: string;
  modifiers: Modifiers;
} {
  const trimmedKeyName = keyName.trim();
  invariant(trimmedKeyName.length > 0, 'Key name must not be empty');

  const tokens = trimmedKeyName.split('+').map((token) => token.trim());
  invariant(tokens.length > 0, 'Key name must contain a base key');

  const baseKey = tokens.at(-1);
  invariant(
    baseKey !== undefined && baseKey.length > 0,
    'Key name must contain a base key',
  );

  const modifiers: Modifiers = {
    ctrl: false,
    alt: false,
    shift: false,
  };

  for (const token of tokens.slice(0, -1)) {
    invariant(token.length > 0, `Invalid key token in ${keyName}`);

    const lowerToken = token.toLowerCase();
    invariant(lowerToken in modifiers, `Unknown modifier: ${token}`);

    const modifier = lowerToken as keyof Modifiers;
    invariant(!modifiers[modifier], `Duplicate modifier: ${token}`);
    modifiers[modifier] = true;
  }

  invariant(
    !(baseKey.toLowerCase() in modifiers),
    `Missing base key in ${keyName}`,
  );

  return { baseKey, modifiers };
}

function encodeSimpleKey(
  baseKey: string,
  sequence: string,
  modifiers: Modifiers,
): string {
  if (!hasModifiers(modifiers)) {
    return sequence;
  }

  if (
    baseKey === 'tab' &&
    modifiers.shift &&
    !modifiers.ctrl &&
    !modifiers.alt
  ) {
    return '\x1b[Z';
  }

  if (modifiers.alt && !modifiers.ctrl && !modifiers.shift) {
    return `\x1b${sequence}`;
  }

  invariant(
    false,
    `Unsupported modifier combination for ${baseKey}: ${formatModifiers(modifiers)}`,
  );
}

function encodeCsiFinalKey(
  keySpec: CsiFinalKeySpec,
  modifiers: Modifiers,
): string {
  if (!hasModifiers(modifiers)) {
    return keySpec.unmodified;
  }

  const modifierParameter = String(getModifierParameter(modifiers));
  return `\x1b[1;${modifierParameter}${keySpec.final}`;
}

function encodeCsiTildeKey(keyCode: number, modifiers: Modifiers): string {
  const keyCodeText = String(keyCode);

  if (!hasModifiers(modifiers)) {
    return `\x1b[${keyCodeText}~`;
  }

  const modifierParameter = String(getModifierParameter(modifiers));
  return `\x1b[${keyCodeText};${modifierParameter}~`;
}

function encodePrintableCharacter(
  character: string,
  modifiers: Modifiers,
  displayKey: string,
): string {
  invariant(
    character.length === 1,
    `Printable key must be a single character: ${displayKey}`,
  );
  invariant(
    PRINTABLE_ASCII.test(character),
    `Unsupported printable key: ${displayKey}`,
  );

  if (!hasModifiers(modifiers)) {
    return character;
  }

  if (modifiers.ctrl) {
    if (modifiers.shift) {
      invariant(
        ASCII_LETTER.test(character),
        `Unsupported modifier combination for ${displayKey}: ${formatModifiers(modifiers)}`,
      );
    }

    const controlCharacter = getControlCharacter(character);
    invariant(
      controlCharacter !== undefined,
      `Unsupported modifier combination for ${displayKey}: ${formatModifiers(modifiers)}`,
    );

    return modifiers.alt ? `\x1b${controlCharacter}` : controlCharacter;
  }

  if (modifiers.alt) {
    if (modifiers.shift) {
      invariant(
        ASCII_LETTER.test(character),
        `Unsupported modifier combination for ${displayKey}: ${formatModifiers(modifiers)}`,
      );
      return `\x1b${character.toUpperCase()}`;
    }

    return `\x1b${character}`;
  }

  if (modifiers.shift) {
    invariant(
      ASCII_LETTER.test(character),
      `Unsupported modifier combination for ${displayKey}: ${formatModifiers(modifiers)}`,
    );
    return character.toUpperCase();
  }

  invariant(
    false,
    `Unsupported modifier combination for ${displayKey}: ${formatModifiers(modifiers)}`,
  );
}

function getControlCharacter(character: string): string | undefined {
  if (ASCII_LETTER.test(character)) {
    return String.fromCharCode(character.toUpperCase().charCodeAt(0) - 64);
  }

  switch (character) {
    case ' ':
      return '\x00';
    case '@':
      return '\x00';
    case '[':
      return '\x1b';
    case '\\':
      return '\x1c';
    case ']':
      return '\x1d';
    case '^':
      return '\x1e';
    case '_':
      return '\x1f';
    case '?':
      return '\x7f';
    default:
      return undefined;
  }
}

function hasModifiers(modifiers: Modifiers): boolean {
  return modifiers.ctrl || modifiers.alt || modifiers.shift;
}

function getModifierParameter(modifiers: Modifiers): number {
  invariant(
    hasModifiers(modifiers),
    'Modifier parameter requires at least one modifier',
  );

  return (
    1 +
    Number(modifiers.shift) +
    Number(modifiers.alt) * 2 +
    Number(modifiers.ctrl) * 4
  );
}

function formatModifiers(modifiers: Modifiers): string {
  return ['ctrl', 'alt', 'shift']
    .filter((modifier) => modifiers[modifier as keyof Modifiers])
    .join('+');
}
