import { describe, expect, it } from 'vitest';

import { validateTriageLabelTransition } from '../../../.sandcastle/lib/labelInvariants.js';

describe('validateTriageLabelTransition', () => {
  it('computes a state transition that leaves one category and one state', () => {
    expect(
      validateTriageLabelTransition({
        currentLabels: ['bug', 'needs-triage'],
        nextCategory: 'bug',
        nextState: 'ready-for-agent',
      }),
    ).toEqual({
      ok: true,
      addLabels: ['ready-for-agent'],
      removeLabels: ['needs-triage'],
    });
  });

  it('computes a category change', () => {
    expect(
      validateTriageLabelTransition({
        currentLabels: ['bug', 'needs-triage'],
        nextCategory: 'enhancement',
        nextState: 'ready-for-human',
      }),
    ).toEqual({
      ok: true,
      addLabels: ['enhancement', 'ready-for-human'],
      removeLabels: ['bug', 'needs-triage'],
    });
  });

  it('rejects nextCategory null without one current category', () => {
    expect(
      validateTriageLabelTransition({
        currentLabels: ['needs-triage'],
        nextCategory: null,
        nextState: 'needs-info',
      }),
    ).toEqual({
      ok: false,
      reason:
        'exactly one current category label is required when nextCategory is null',
    });
  });

  it('rejects conflicting current state labels', () => {
    const result = validateTriageLabelTransition({
      currentLabels: ['bug', 'needs-triage', 'needs-info'],
      nextCategory: 'bug',
      nextState: 'ready-for-agent',
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: 'conflicting state labels: needs-info, needs-triage',
    });
  });
});
