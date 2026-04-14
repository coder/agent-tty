import { PromptEvalCaseSchema } from '../../lib/schemas.js';
import type { PromptEvalCase } from '../../lib/types.js';

const PROMPT_TIMEOUT_MS = 30_000;
const EMPTY_ANTI_PATTERNS: PromptEvalCase['antiPatterns'] = [];

function requiredCheck(
  id: string,
  description: string,
  requiredPatterns: string[],
  forbiddenPatterns: string[] = [],
): PromptEvalCase['workflowChecks'][number] {
  return {
    id,
    description,
    required: true,
    requiredPatterns,
    forbiddenPatterns,
    dependsOn: [],
  };
}

function parseCase(evalCase: PromptEvalCase): PromptEvalCase {
  return PromptEvalCaseSchema.parse(evalCase) as PromptEvalCase;
}

export const TRIGGER_DOGFOOD_TUI_PROMPT_CASES: PromptEvalCase[] = [
  parseCase({
    id: 'exploratory-testing',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Explore this TUI application and find any bugs or issues, then report what you found with evidence',
    expectedSkill: 'dogfood-tui',
    context:
      'This is structured TUI QA work that should produce reviewable evidence rather than a one-off terminal run.',
    expectedPatterns: [
      '/dogfood-tui/i',
      '/\\b(?:dogfood|qa|exploratory|testing)\\b/i',
      '/\\b(?:evidence|screenshot|proof|bundle)\\b/i',
    ],
    forbiddenPatterns: ['/\\btmux\\b/i', '/\\bscreen\\b/i', '/sleep \\d+/i'],
    rubric: [
      'Routes exploratory QA to dogfood-tui rather than plain terminal automation.',
      'Mentions collecting evidence such as screenshots, proof, or a review bundle.',
    ],
    workflowChecks: [
      requiredCheck(
        'exploratory-testing.select-dogfood-tui',
        'Explicitly selects dogfood-tui.',
        ['/dogfood-tui/i'],
      ),
      requiredCheck(
        'exploratory-testing.collect-evidence',
        'Frames the task as exploratory QA with evidence capture.',
        [
          '/\\b(?:dogfood|qa|exploratory|testing)\\b/i',
          '/\\b(?:evidence|screenshot|proof|bundle)\\b/i',
        ],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'bug-hunting',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Do a thorough bug hunt on this terminal app — look for rendering issues, input problems, and edge cases',
    expectedSkill: 'dogfood-tui',
    context:
      'The plan should describe structured QA coverage for rendering, input, and edge cases with reviewable findings.',
    expectedPatterns: [
      '/dogfood-tui/i',
      '/\\b(?:dogfood|bug.*hunt|qa)\\b/i',
      '/\\b(?:render|input|edge)\\b/i',
    ],
    forbiddenPatterns: ['/\\btmux\\b/i', '/\\bscreen\\b/i', '/sleep \\d+/i'],
    rubric: [
      'Selects dogfood-tui for bug-hunting work on a terminal application.',
      'Covers rendering, input, and edge-case investigation explicitly.',
    ],
    workflowChecks: [
      requiredCheck(
        'bug-hunting.select-dogfood-tui',
        'Explicitly selects dogfood-tui.',
        ['/dogfood-tui/i'],
      ),
      requiredCheck(
        'bug-hunting.cover-risk-areas',
        'Calls out rendering, input, and edge-case coverage.',
        ['/\\b(?:dogfood|bug.*hunt|qa)\\b/i', '/\\b(?:render|input|edge)\\b/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'release-readiness',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'This TUI is about to ship v2.0 — do a release readiness check and produce a quality report',
    expectedSkill: 'dogfood-tui',
    context:
      'Release-readiness validation should use a structured QA pass and produce a report or checklist with evidence.',
    expectedPatterns: [
      '/dogfood-tui/i',
      '/\\b(?:release|readiness|quality)\\b/i',
      '/\\b(?:report|checklist)\\b/i',
    ],
    forbiddenPatterns: ['/\\btmux\\b/i', '/\\bscreen\\b/i', '/sleep \\d+/i'],
    rubric: [
      'Routes release-readiness work to dogfood-tui.',
      'Mentions a quality report or checklist rather than an ad hoc run.',
    ],
    workflowChecks: [
      requiredCheck(
        'release-readiness.select-dogfood-tui',
        'Explicitly selects dogfood-tui.',
        ['/dogfood-tui/i'],
      ),
      requiredCheck(
        'release-readiness.report-quality',
        'Frames the work as a release-quality check with a report or checklist.',
        [
          '/\\b(?:release|readiness|quality)\\b/i',
          '/\\b(?:report|checklist)\\b/i',
        ],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'ux-review',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Review the UX of this terminal application — navigation, responsiveness, visual consistency',
    expectedSkill: 'dogfood-tui',
    context:
      'The task is a usability review of a TUI, so the answer should emphasize assessment and reviewer-facing evidence.',
    expectedPatterns: [
      '/dogfood-tui/i',
      '/\\b(?:ux|user.*experience|usability)\\b/i',
      '/\\b(?:review|assess)\\b/i',
    ],
    forbiddenPatterns: ['/\\btmux\\b/i', '/\\bscreen\\b/i', '/sleep \\d+/i'],
    rubric: [
      'Selects dogfood-tui for a TUI UX review.',
      'Uses review or assessment language focused on navigation and usability.',
    ],
    workflowChecks: [
      requiredCheck(
        'ux-review.select-dogfood-tui',
        'Explicitly selects dogfood-tui.',
        ['/dogfood-tui/i'],
      ),
      requiredCheck(
        'ux-review.assess-usability',
        'Frames the work as UX assessment of the TUI.',
        [
          '/\\b(?:ux|user.*experience|usability)\\b/i',
          '/\\b(?:review|assess)\\b/i',
        ],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'issue-reproduction',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'A user reported that the TUI crashes on resize — reproduce the issue and capture evidence for the bug report',
    expectedSkill: 'dogfood-tui',
    context:
      'The answer should describe reproduction plus evidence capture, because the goal is a reviewable bug report.',
    expectedPatterns: [
      '/dogfood-tui/i',
      '/\\b(?:reproduce|repro)\\b/i',
      '/\\b(?:evidence|screenshot|recording)\\b/i',
    ],
    forbiddenPatterns: ['/\\btmux\\b/i', '/\\bscreen\\b/i', '/sleep \\d+/i'],
    rubric: [
      'Routes bug reproduction for a TUI issue to dogfood-tui.',
      'Mentions reproduction steps plus evidence such as screenshots or recordings.',
    ],
    workflowChecks: [
      requiredCheck(
        'issue-reproduction.select-dogfood-tui',
        'Explicitly selects dogfood-tui.',
        ['/dogfood-tui/i'],
      ),
      requiredCheck(
        'issue-reproduction.repro-and-evidence',
        'Combines reproduction with evidence capture.',
        [
          '/\\b(?:reproduce|repro)\\b/i',
          '/\\b(?:evidence|screenshot|recording)\\b/i',
        ],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'regression-triage',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Check if the scrollback behavior regression from v1.3 is still present in this build',
    expectedSkill: 'dogfood-tui',
    context:
      'This is regression triage for a TUI behavior issue and should be framed as structured QA rather than a generic terminal run.',
    expectedPatterns: [
      '/dogfood-tui/i',
      '/\\b(?:regression|triage)\\b/i',
      '/\\b(?:scrollback|behavior)\\b/i',
    ],
    forbiddenPatterns: ['/\\btmux\\b/i', '/\\bscreen\\b/i', '/sleep \\d+/i'],
    rubric: [
      'Routes scrollback regression triage to dogfood-tui.',
      'Names the regression/triage task and the scrollback behavior under test.',
    ],
    workflowChecks: [
      requiredCheck(
        'regression-triage.select-dogfood-tui',
        'Explicitly selects dogfood-tui.',
        ['/dogfood-tui/i'],
      ),
      requiredCheck(
        'regression-triage.name-regression',
        'Frames the task as regression triage for scrollback behavior.',
        ['/\\b(?:regression|triage)\\b/i', '/\\b(?:scrollback|behavior)\\b/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
];
