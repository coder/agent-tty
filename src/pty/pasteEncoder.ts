import { invariant } from '../util/assert.js';

export function encodePaste(text: string): string {
  invariant(typeof text === 'string', 'Paste text must be a string');
  invariant(text.length > 0, 'Paste text must not be empty');

  return `\x1b[200~${text}\x1b[201~`;
}
