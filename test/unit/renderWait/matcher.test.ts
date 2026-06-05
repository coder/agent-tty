import { describe, expect, it } from 'vitest';

import {
  hasNestedQuantifiers,
  matchRenderWaitSnapshot,
  MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH,
  prepareRenderWaitCondition,
  safeRegexExec,
} from '../../../src/renderWait/matcher.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { createTestSemanticSnapshot } from '../../helpers.js';

describe('render wait matcher', () => {
  it('matches text in visible snapshot lines', () => {
    const condition = prepareRenderWaitCondition({ text: 'Ready' });
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [
        { row: 0, text: 'booting' },
        { row: 1, text: 'Ready' },
      ],
      cursorRow: 1,
      cursorCol: 5,
      capturedAtSeq: 12,
    });

    expect(matchRenderWaitSnapshot(condition, snapshot)).toEqual({
      matched: true,
      textMatched: true,
      cursorMatched: true,
      stabilityMatched: true,
      baselineMatched: true,
      contentAndCursorMatched: true,
      matchedText: 'Ready',
      cursorRow: 1,
      cursorCol: 5,
      capturedAtSeq: 12,
      visibleLines: ['booting', 'Ready'],
    });
  });

  it('rejects snapshots at or below the wait baseline even when text matches', () => {
    const condition = prepareRenderWaitCondition({
      text: 'Ready',
      afterSeq: 12,
    });
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 0, text: 'Ready' }],
      capturedAtSeq: 12,
    });

    expect(matchRenderWaitSnapshot(condition, snapshot)).toMatchObject({
      matched: false,
      textMatched: true,
      cursorMatched: true,
      stabilityMatched: true,
      baselineMatched: false,
      contentAndCursorMatched: true,
    });
  });

  it('matches snapshots strictly beyond the wait baseline', () => {
    const condition = prepareRenderWaitCondition({
      text: 'Ready',
      afterSeq: 12,
    });
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 0, text: 'Ready' }],
      capturedAtSeq: 13,
    });

    expect(matchRenderWaitSnapshot(condition, snapshot)).toMatchObject({
      matched: true,
      textMatched: true,
      baselineMatched: true,
      contentAndCursorMatched: true,
      matchedText: 'Ready',
    });
  });

  it('treats an undefined wait baseline as always satisfied', () => {
    const condition = prepareRenderWaitCondition({ text: 'Ready' });
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 0, text: 'Ready' }],
      capturedAtSeq: 0,
    });

    expect(matchRenderWaitSnapshot(condition, snapshot)).toMatchObject({
      matched: true,
      baselineMatched: true,
    });
  });

  it('rejects non-integer afterSeq baselines', () => {
    expect(() =>
      prepareRenderWaitCondition({ text: 'Ready', afterSeq: 1.5 }),
    ).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'afterSeq must be a non-negative integer',
      }),
    );
  });

  it('matches regexes and reports the matched substring', () => {
    const condition = prepareRenderWaitCondition({ regex: '\\d+ items' });
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 0, text: 'found 42 items' }],
    });

    expect(matchRenderWaitSnapshot(condition, snapshot)).toMatchObject({
      matched: true,
      textMatched: true,
      matchedText: '42 items',
    });
  });

  it('rejects text and regex together', () => {
    expect(() =>
      prepareRenderWaitCondition({ text: 'hello', regex: 'world' }),
    ).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'waitForRender text and regex filters are mutually exclusive',
      }),
    );
  });

  it('rejects regex patterns with nested quantifiers', () => {
    expect(hasNestedQuantifiers('(a+)+')).toBe(true);
    expect(hasNestedQuantifiers('(a*)+')).toBe(true);
    expect(hasNestedQuantifiers('(a+)*')).toBe(true);
    expect(hasNestedQuantifiers('(a?){2}')).toBe(true);
    expect(hasNestedQuantifiers('(.*)+')).toBe(true);
    expect(hasNestedQuantifiers('([^)]*)+')).toBe(true);
    expect(() => prepareRenderWaitCondition({ regex: '(a+)+' })).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: expect.stringContaining('nested quantifiers') as string,
      }),
    );
  });

  it('allows regex patterns without nested quantifiers', () => {
    expect(hasNestedQuantifiers('a+')).toBe(false);
    expect(hasNestedQuantifiers('(abc)+')).toBe(false);
    expect(hasNestedQuantifiers('\\d{3}')).toBe(false);
    expect(hasNestedQuantifiers('[a-z]+')).toBe(false);
    expect(hasNestedQuantifiers('(a|b)+')).toBe(false);
  });

  it('rejects malformed regexes', () => {
    expect(() => prepareRenderWaitCondition({ regex: '[' })).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: expect.stringContaining('Invalid regex pattern') as string,
      }),
    );
  });

  it('validates text and regex lengths', () => {
    expect(() => prepareRenderWaitCondition({ text: '' })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    );
    expect(() =>
      prepareRenderWaitCondition({ text: 'a'.repeat(1001) }),
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }));
    expect(() => prepareRenderWaitCondition({ regex: '' })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    );
    expect(() =>
      prepareRenderWaitCondition({ regex: 'a'.repeat(201) }),
    ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }));
  });

  it.each([
    [{}, 'at least one of'],
    [{ screenStableMs: -1 }, 'positive integer'],
    [{ screenStableMs: 0.5 }, 'positive integer'],
    [{ cursorRow: -1 }, 'non-negative integer'],
    [{ cursorRow: 1.5 }, 'non-negative integer'],
    [{ cursorCol: -1 }, 'non-negative integer'],
    [{ cursorCol: 1.5 }, 'non-negative integer'],
  ])('rejects invalid condition %j', (condition, expectedMessage) => {
    expect(() => prepareRenderWaitCondition(condition)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: expect.stringContaining(expectedMessage) as string,
      }),
    );
  });

  it('accepts text and regex boundary lengths', () => {
    expect(() => prepareRenderWaitCondition({ text: 'a' })).not.toThrow();
    expect(() =>
      prepareRenderWaitCondition({ text: 'a'.repeat(1000) }),
    ).not.toThrow();
    expect(() => prepareRenderWaitCondition({ regex: 'a' })).not.toThrow();
    expect(() =>
      prepareRenderWaitCondition({ regex: 'a'.repeat(200) }),
    ).not.toThrow();
  });

  it('fails fast when a prepared regex condition is malformed internally', () => {
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 0, text: 'not matching' }],
    });

    expect(() =>
      matchRenderWaitSnapshot({ regex: 'matching' }, snapshot),
    ).toThrow(/must have compiledRegex/u);
    expect(() =>
      matchRenderWaitSnapshot(
        { regex: 'not', compiledRegex: /not/g },
        snapshot,
      ),
    ).toThrow(/stateful global or sticky flags/u);
  });

  it('searches regexes only against the first 50KB of visible text', () => {
    const underLimitText = `${'a'.repeat(100)}Z`;
    const withinLimitBoundaryText = `${'a'.repeat(MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH - 1)}Z`;
    const beyondLimitBoundaryText = `${'a'.repeat(MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH + 1)}Z`;

    expect(safeRegexExec(/Z/u, underLimitText)?.index).toBe(100);
    expect(safeRegexExec(/Z/u, withinLimitBoundaryText)?.index).toBe(
      MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH - 1,
    );
    expect(safeRegexExec(/Z/u, beyondLimitBoundaryText)).toBeNull();
  });

  it('matches cursor row and column alone and with text', () => {
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 4, text: 'Ready' }],
      cursorRow: 4,
      cursorCol: 2,
    });

    expect(
      matchRenderWaitSnapshot(
        prepareRenderWaitCondition({ cursorRow: 4, cursorCol: 2 }),
        snapshot,
      ),
    ).toMatchObject({
      matched: true,
      textMatched: true,
      cursorMatched: true,
    });
    expect(
      matchRenderWaitSnapshot(
        prepareRenderWaitCondition({ text: 'Ready', cursorRow: 4 }),
        snapshot,
      ),
    ).toMatchObject({
      matched: true,
      textMatched: true,
      cursorMatched: true,
      matchedText: 'Ready',
    });
    expect(
      matchRenderWaitSnapshot(
        prepareRenderWaitCondition({ cursorRow: 5 }),
        snapshot,
      ),
    ).toMatchObject({
      matched: false,
      textMatched: true,
      cursorMatched: false,
      contentAndCursorMatched: false,
    });
  });

  it('matches screen stability only when stableForMs reaches screenStableMs', () => {
    const condition = prepareRenderWaitCondition({ screenStableMs: 500 });
    const snapshot = createTestSemanticSnapshot();

    expect(matchRenderWaitSnapshot(condition, snapshot)).toMatchObject({
      matched: false,
      textMatched: true,
      cursorMatched: true,
      stabilityMatched: false,
      contentAndCursorMatched: true,
    });
    expect(
      matchRenderWaitSnapshot(condition, snapshot, { stableForMs: 499 }),
    ).toMatchObject({ matched: false, stabilityMatched: false });
    expect(
      matchRenderWaitSnapshot(condition, snapshot, { stableForMs: 500 }),
    ).toMatchObject({ matched: true, stabilityMatched: true });
  });

  it('ignores scrollback when matching visible viewport text', () => {
    const condition = prepareRenderWaitCondition({ text: 'scrollback only' });
    const snapshot = createTestSemanticSnapshot({
      visibleLines: [{ row: 0, text: 'visible only' }],
      scrollbackLines: [{ row: 0, text: 'scrollback only' }],
    });

    expect(matchRenderWaitSnapshot(condition, snapshot)).toMatchObject({
      matched: false,
      textMatched: false,
      visibleLines: ['visible only'],
    });
  });
});
