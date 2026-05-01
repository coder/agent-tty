import { invariant } from '../../src/util/assert.js';
import type { TriageState } from './afkMarker.js';
import { isTriageState, TRIAGE_STATES } from './afkMarker.js';

export type TriageCategory = 'bug' | 'enhancement';

const CATEGORY_LABELS = new Set<TriageCategory>(['bug', 'enhancement']);
// Reuse afkMarker.ts's TRIAGE_STATES so the validator and the type guard
// cannot drift if a state is added in only one of the two places.
const STATE_LABELS: ReadonlySet<TriageState> = TRIAGE_STATES;

export type LabelTransitionResult =
  | {
      readonly ok: true;
      readonly addLabels: readonly string[];
      readonly removeLabels: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface LabelTransitionInput {
  readonly currentLabels: readonly string[];
  readonly nextCategory: TriageCategory | null;
  readonly nextState: TriageState;
}

export function validateTriageLabelTransition(
  input: LabelTransitionInput,
): LabelTransitionResult {
  invariant(
    Array.isArray(input.currentLabels),
    'current labels must be an array',
  );
  invariant(
    isTriageState(input.nextState),
    'next state must be a triage state',
  );

  const current = new Set(input.currentLabels);
  const currentCategories = input.currentLabels.filter(isCategoryLabel);
  const currentStates = input.currentLabels.filter(isStateLabel);

  if (currentCategories.length > 1) {
    return {
      ok: false,
      reason: `conflicting category labels: ${currentCategories.sort().join(', ')}`,
    };
  }

  if (currentStates.length > 1) {
    return {
      ok: false,
      reason: `conflicting state labels: ${currentStates.sort().join(', ')}`,
    };
  }

  if (input.nextCategory === null && currentCategories.length !== 1) {
    return {
      ok: false,
      reason:
        'exactly one current category label is required when nextCategory is null',
    };
  }

  const next = new Set(current);
  for (const category of CATEGORY_LABELS) {
    next.delete(category);
  }
  for (const state of STATE_LABELS) {
    next.delete(state);
  }

  const afterCategory = input.nextCategory ?? currentCategories[0];
  invariant(
    afterCategory !== undefined,
    'category must exist after nextCategory null validation',
  );

  next.add(afterCategory);
  next.add(input.nextState);

  const afterLabels = Array.from(next);
  const afterCategories = afterLabels.filter(isCategoryLabel);
  const afterStates = afterLabels.filter(isStateLabel);

  if (afterCategories.length !== 1 || afterStates.length !== 1) {
    return {
      ok: false,
      reason:
        'label transition must leave exactly one category and one state label',
    };
  }

  const addLabels = afterLabels
    .filter((label) => !current.has(label))
    .sort(compareLabel);
  const removeLabels = input.currentLabels
    .filter((label) => !next.has(label))
    .sort(compareLabel);

  return {
    ok: true,
    addLabels,
    removeLabels,
  };
}

function isCategoryLabel(label: string): label is TriageCategory {
  return CATEGORY_LABELS.has(label as TriageCategory);
}

function isStateLabel(label: string): label is TriageState {
  return STATE_LABELS.has(label as TriageState);
}

function compareLabel(left: string, right: string): number {
  return left.localeCompare(right);
}
