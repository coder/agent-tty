import { describe, expect, it } from 'vitest';

import { parseBatchPlan } from '../../../src/batch/plan.js';
import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';

function parse(steps: unknown): ReturnType<typeof parseBatchPlan> {
  return parseBatchPlan(JSON.stringify(steps));
}

function captureParseError(steps: unknown): CliError {
  try {
    parse(steps);
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected parseBatchPlan to throw');
}

describe('parseBatchPlan', () => {
  describe('valid plans', () => {
    it('parses a type step', () => {
      expect(parse([{ type: 'hello' }]).steps).toEqual([
        { kind: 'type', text: 'hello' },
      ]);
    });

    it('parses a paste step', () => {
      expect(parse([{ paste: 'pasted text' }]).steps).toEqual([
        { kind: 'paste', text: 'pasted text' },
      ]);
    });

    it('parses a sendKeys step', () => {
      expect(
        parse([{ sendKeys: ['Escape', 'ctrl+c', 'Enter'] }]).steps,
      ).toEqual([{ kind: 'sendKeys', keys: ['Escape', 'ctrl+c', 'Enter'] }]);
    });

    it('parses a run step with noWait defaulting to false (Waited Run)', () => {
      expect(parse([{ run: 'echo hi' }]).steps).toEqual([
        {
          kind: 'run',
          command: 'echo hi',
          noWait: false,
          timeoutMs: undefined,
        },
      ]);
    });

    it('parses a run step honoring noWait and timeout', () => {
      expect(
        parse([{ run: 'nvim --clean', noWait: true, timeout: 2000 }]).steps,
      ).toEqual([
        {
          kind: 'run',
          command: 'nvim --clean',
          noWait: true,
          timeoutMs: 2000,
        },
      ]);
    });

    it('parses a wait step and prepares the condition', () => {
      const step = parse([{ wait: { text: 'written', timeout: 5000 } }])
        .steps[0];
      expect(step).toMatchObject({
        kind: 'wait',
        timeoutMs: 5000,
        condition: { text: 'written' },
      });
    });

    it('normalizes a wait timeout of 0 to undefined (infinite)', () => {
      const step = parse([{ wait: { text: 'done', timeout: 0 } }]).steps[0];
      expect(step).toMatchObject({ kind: 'wait', timeoutMs: undefined });
    });

    it('treats an absent wait timeout as undefined', () => {
      const step = parse([{ wait: { screenStableMs: 1000 } }]).steps[0];
      expect(step).toMatchObject({ kind: 'wait', timeoutMs: undefined });
    });

    it('compiles a wait regex condition', () => {
      const step = parse([{ wait: { regex: '\\d+ items' } }]).steps[0];
      expect(step).toMatchObject({ kind: 'wait' });
      if (step?.kind === 'wait') {
        expect(step.condition.compiledRegex).toBeInstanceOf(RegExp);
      }
    });

    it('parses an ordered multi-step plan preserving order', () => {
      const { steps } = parse([
        { run: 'nvim --clean', noWait: true },
        { wait: { screenStableMs: 1000 } },
        { sendKeys: ['i'] },
        { type: 'hello' },
        { sendKeys: ['Escape', 'Enter'] },
        { wait: { text: 'written' } },
      ]);
      expect(steps.map((step) => step.kind)).toEqual([
        'run',
        'wait',
        'sendKeys',
        'type',
        'sendKeys',
        'wait',
      ]);
    });
  });

  describe('malformed top-level input', () => {
    it('rejects invalid JSON', () => {
      expect(() => parseBatchPlan('{not json')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Batch steps must be valid JSON.',
        }),
      );
    });

    it('rejects a top-level object', () => {
      expect(() => parseBatchPlan('{}')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Batch steps must be a JSON array.',
        }),
      );
    });

    it('rejects a top-level number', () => {
      expect(() => parseBatchPlan('5')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Batch steps must be a JSON array.',
        }),
      );
    });

    it('rejects a top-level string', () => {
      expect(() => parseBatchPlan('"x"')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Batch steps must be a JSON array.',
        }),
      );
    });

    it('rejects a top-level null', () => {
      expect(() => parseBatchPlan('null')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Batch steps must be a JSON array.',
        }),
      );
    });

    it('rejects an empty array', () => {
      expect(() => parseBatchPlan('[]')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Batch must contain at least one step.',
        }),
      );
    });
  });

  describe('malformed steps', () => {
    it('rejects a non-object step with its index', () => {
      expect(() => parse([42])).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          details: { stepIndex: 0 },
        }),
      );
    });

    it('rejects a null step', () => {
      expect(() => parse([null])).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    });

    it('rejects an array step', () => {
      expect(() => parse([['type', 'x']])).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    });

    it('rejects a zero-verb step', () => {
      expect(() => parse([{ frob: 1 }])).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message:
            'Batch step 0 must have exactly one of type|paste|sendKeys|run|wait; found none',
          details: { stepIndex: 0 },
        }),
      );
    });

    it('rejects a two-verb step listing the conflicting verbs', () => {
      expect(() => parse([{ type: 'a', wait: { text: 'x' } }])).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message:
            'Batch step 0 must have exactly one of type|paste|sendKeys|run|wait; found type, wait',
          details: { stepIndex: 0 },
        }),
      );
    });

    it('reports the failing step index in a multi-step plan', () => {
      expect(() =>
        parse([{ type: 'ok' }, { type: 'ok' }, { frob: 1 }]),
      ).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          details: { stepIndex: 2 },
        }),
      );
    });

    it('rejects an unknown payload key on a verb step (no inline wait)', () => {
      expect(captureParseError([{ run: 'x', text: 'y' }])).toMatchObject({
        code: ERROR_CODES.INVALID_INPUT,
        details: { stepIndex: 0 },
      });
    });

    it('rejects an empty type string', () => {
      expect(() => parse([{ type: '' }])).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    });
  });

  describe('sendKeys validation', () => {
    it('rejects sendKeys that is not an array', () => {
      expect(captureParseError([{ sendKeys: 'Enter' }])).toMatchObject({
        code: ERROR_CODES.INVALID_INPUT,
        details: { stepIndex: 0 },
      });
    });

    it('rejects an empty sendKeys array', () => {
      expect(captureParseError([{ sendKeys: [] }])).toMatchObject({
        code: ERROR_CODES.INVALID_INPUT,
        details: { stepIndex: 0 },
      });
    });

    it('rejects an invalid key name at parse time with INVALID_KEYS', () => {
      expect(() => parse([{ sendKeys: ['Enter', 'BOGUS'] }])).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_KEYS }),
      );
    });
  });

  describe('wait condition validation', () => {
    it('rejects a wait with text and regex together', () => {
      expect(() => parse([{ wait: { text: 'a', regex: 'b' } }])).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message:
            'waitForRender text and regex filters are mutually exclusive',
        }),
      );
    });

    it('rejects a wait regex prone to catastrophic backtracking', () => {
      expect(() => parse([{ wait: { regex: '(a+)+' } }])).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    });

    it('rejects a wait with a negative cursor', () => {
      expect(() => parse([{ wait: { cursorRow: -1 } }])).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    });

    it('rejects a wait with no condition', () => {
      expect(() => parse([{ wait: {} }])).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.INVALID_INPUT,
          message:
            'waitForRender requires at least one of text, regex, screenStableMs, cursorRow, or cursorCol',
        }),
      );
    });
  });
});
