import { describe, expect, it } from 'vitest';

import {
  MAX_ERROR_SUMMARY_CHARS,
  summarizeError,
} from '../../../src/util/errorSummary.js';

describe('summarizeError', () => {
  it('gives the message of an error', () => {
    expect(summarizeError(new Error('boot failed'))).toBe('boot failed');
  });

  it('keeps the first line and drops the stack frames and the call log', () => {
    const error = new Error(
      [
        'page.evaluate: RangeError: offset is out of bounds',
        '    at Terminal.write (http://127.0.0.1:41233/assets/ghostty-web.js:1:2)',
        '    at writeBatch (file:///home/user/agent-tty/index.html:2:3)',
      ].join('\n'),
    );

    expect(summarizeError(error)).toBe(
      'page.evaluate: RangeError: offset is out of bounds',
    );
  });

  it('skips blank lines before the first line and collapses whitespace', () => {
    expect(
      summarizeError(new Error('\r\n  \n  page\t crashed   badly \n')),
    ).toBe('page crashed badly');
  });

  it('cuts a long line to the limit and ends it with an ellipsis', () => {
    const summary = summarizeError(new Error('x'.repeat(5000)));

    expect(summary).toHaveLength(MAX_ERROR_SUMMARY_CHARS);
    expect(summary).toBe(`${'x'.repeat(MAX_ERROR_SUMMARY_CHARS - 1)}…`);
  });

  it('keeps a line that is exactly at the limit', () => {
    const line = 'y'.repeat(MAX_ERROR_SUMMARY_CHARS);

    expect(summarizeError(new Error(line))).toBe(line);
  });

  it('does not cut a surrogate pair in half', () => {
    // The pair starts at the last character that the cut would keep.
    const text = `${'z'.repeat(MAX_ERROR_SUMMARY_CHARS - 2)}😀😀`;

    const summary = summarizeError(new Error(text));

    expect(summary).toBe(`${'z'.repeat(MAX_ERROR_SUMMARY_CHARS - 2)}…`);
    expect(summary).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it('gives the name of an error without a message', () => {
    expect(summarizeError(new RangeError(''))).toBe('RangeError');
  });

  it('gives the text of a value that is not an error', () => {
    expect(summarizeError('plain text\nsecond line')).toBe('plain text');
    expect(summarizeError(42)).toBe('42');
    expect(summarizeError(undefined)).toBe('undefined');
  });
});
