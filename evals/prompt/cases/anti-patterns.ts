import { PromptEvalCaseSchema } from '../../lib/schemas.js';
import type { PromptEvalCase } from '../../lib/types.js';

const PROMPT_TIMEOUT_MS = 30_000;
const EMPTY_ANTI_PATTERNS: PromptEvalCase['antiPatterns'] = [];
const TMUX_RECOMMENDATION_PATTERN = String.raw`/(?:^|\n)\s*tmux\b[^\n]*|(?:(?<=\buse\s)|(?<=\bstart\s)|(?<=\blaunch\s)|(?<=\brun\s)|(?<=\bcreate\s)|(?<=\bcreate a\s))tmux\b/i`;
const SCREEN_RECOMMENDATION_PATTERN = String.raw`/(?:^|\n)\s*screen\b[^\n]*|(?:(?<=\buse\s)|(?<=\bstart\s)|(?<=\blaunch\s)|(?<=\brun\s)|(?<=\bcreate\s)|(?<=\bcreate a\s))(?:gnu\s+)?screen\b/i`;
const SLEEP_RECOMMENDATION_PATTERN = String.raw`/(?:^|\n)\s*sleep\s+\d+(?:\.\d+)?\b|(?:(?<=\buse\s)|(?<=\brun\s)|(?<=\badd\s)|(?<=\binsert\s))sleep\s+\d+(?:\.\d+)?\b/i`;

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

export const ANTI_PATTERN_PROMPT_CASES: PromptEvalCase[] = [
  parseCase({
    id: 'blind-sleep',
    lane: 'prompt',
    category: 'anti-pattern',
    prompt: 'Run the server and wait 5 seconds, then check if it started',
    expectedSkill: 'agent-tty',
    context:
      'The answer should replace the blind delay with observable terminal readiness checks.',
    expectedPatterns: ['/agent-tty/i', '/\\bwait\\b/i'],
    forbiddenPatterns: [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout.*\\d{4}/i'],
    rubric: [
      'Replaces the fixed sleep with agent-tty wait.',
      'Uses observable readiness rather than arbitrary timing.',
    ],
    workflowChecks: [
      requiredCheck(
        'blind-sleep.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'blind-sleep.replace-delay',
        'Uses wait instead of a hard-coded delay.',
        ['/\\bwait\\b/i'],
        [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout.*\\d{4}/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'tmux-usage',
    lane: 'prompt',
    category: 'anti-pattern',
    prompt: 'Create a tmux session and run the build inside it',
    expectedSkill: 'agent-tty',
    context:
      'The answer should replace tmux with the supported agent-tty session workflow.',
    expectedPatterns: ['/agent-tty/i'],
    forbiddenPatterns: [TMUX_RECOMMENDATION_PATTERN, '/tmux new-session/i'],
    rubric: [
      'Rejects tmux in favor of agent-tty.',
      'Keeps the plan inside the supported session lifecycle.',
    ],
    workflowChecks: [
      requiredCheck(
        'tmux-usage.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'tmux-usage.reject-tmux',
        'Avoids tmux and uses the supported session workflow instead.',
        ['/agent-tty/i'],
        [TMUX_RECOMMENDATION_PATTERN, '/tmux new-session/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'screen-usage',
    lane: 'prompt',
    category: 'anti-pattern',
    prompt: 'Use GNU screen to monitor the long-running process',
    expectedSkill: 'agent-tty',
    context:
      'The answer should replace screen with the supported agent-tty session workflow.',
    expectedPatterns: ['/agent-tty/i'],
    forbiddenPatterns: [SCREEN_RECOMMENDATION_PATTERN, '/screen -S/i'],
    rubric: [
      'Rejects GNU screen in favor of agent-tty.',
      'Keeps the long-running process inside the supported workflow.',
    ],
    workflowChecks: [
      requiredCheck(
        'screen-usage.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'screen-usage.reject-screen',
        'Avoids screen and uses the supported session workflow instead.',
        ['/agent-tty/i'],
        [SCREEN_RECOMMENDATION_PATTERN, '/screen -S/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'adhoc-screenshots',
    lane: 'prompt',
    category: 'anti-pattern',
    prompt: 'Take a screenshot of the terminal using scrot or import',
    expectedSkill: 'agent-tty',
    context:
      'The answer should route screenshot capture through the supported agent-tty artifact workflow.',
    expectedPatterns: ['/agent-tty/i', '/\\bscreenshot\\b/i'],
    forbiddenPatterns: [
      '/\\bscrot\\b/i',
      '/\\bimport\\b.*screenshot/i',
      '/xdotool/i',
    ],
    rubric: [
      'Replaces ad hoc screenshot tools with agent-tty screenshot.',
      'Keeps evidence capture inside the supported artifact workflow.',
    ],
    workflowChecks: [
      requiredCheck(
        'adhoc-screenshots.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'adhoc-screenshots.use-supported-capture',
        'Uses screenshot while avoiding ad hoc desktop capture tools.',
        ['/\\bscreenshot\\b/i'],
        ['/\\bscrot\\b/i', '/\\bimport\\b.*screenshot/i', '/xdotool/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
];
