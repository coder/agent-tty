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

/**
 * Documents and tests the AFK-triage label invariant: after triage an issue
 * has exactly one category label (`bug` | `enhancement`) and exactly one
 * state label (one of `STATE_LABELS`). It also rejects starting states that
 * would silently overwrite conflicting labels.
 *
 * At runtime the invariant is enforced by the triage prompt and the
 * `gh label add/remove` calls Claude makes inside the workspace. This module
 * keeps a machine-checked copy of the same rules so the test suite can prove
 * the prompt's natural-language rules stay consistent with the project's
 * label vocabulary in `docs/agents/triage-labels.md`. It is intentionally
 * not wired into the orchestrator: the orchestrator does not see issue
 * labels — only the in-workspace agent does — so calling this from
 * `main.ts` would only re-validate a copy of state we trust the agent to
 * have managed correctly.
 */
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
