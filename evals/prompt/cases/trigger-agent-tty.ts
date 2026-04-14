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

export const TRIGGER_AGENT_TTY_PROMPT_CASES: PromptEvalCase[] = [
  parseCase({
    id: 'session-creation',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'I need to create a terminal session to run my build script and capture the output',
    expectedSkill: 'agent-tty',
    context:
      'The correct plan should use a session-oriented terminal automation workflow instead of tmux, screen, or blind waiting.',
    expectedPatterns: ['/agent-tty/i', '/\\bcreate\\b/i', '/\\bsession\\b/i'],
    forbiddenPatterns: [
      TMUX_RECOMMENDATION_PATTERN,
      SCREEN_RECOMMENDATION_PATTERN,
      SLEEP_RECOMMENDATION_PATTERN,
    ],
    rubric: [
      'Selects agent-tty as the right skill for long-lived terminal automation.',
      'Uses a create-session workflow to run the build and inspect output.',
    ],
    workflowChecks: [
      requiredCheck(
        'session-creation.select-agent-tty',
        'Explicitly selects agent-tty for terminal automation.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'session-creation.create-session',
        'Creates a terminal session instead of using a multiplexer.',
        ['/\\bcreate\\b/i', '/\\bsession\\b/i'],
        [TMUX_RECOMMENDATION_PATTERN, SCREEN_RECOMMENDATION_PATTERN],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'interactive-cli',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Help me automate an interactive CLI installer that asks questions and needs input at specific prompts',
    expectedSkill: 'agent-tty',
    context:
      'A correct answer should wait for observable prompts before sending input and should use terminal input primitives instead of brittle sleeps.',
    expectedPatterns: [
      '/agent-tty/i',
      '/\\bwait\\b/i',
      '/\\b(?:type|run|input|paste|send-keys)\\b/i',
    ],
    forbiddenPatterns: [
      SLEEP_RECOMMENDATION_PATTERN,
      '/setTimeout/i',
      TMUX_RECOMMENDATION_PATTERN,
    ],
    rubric: [
      'Recognizes the task as interactive terminal automation.',
      'Uses wait plus an input primitive to answer installer prompts safely.',
    ],
    workflowChecks: [
      requiredCheck(
        'interactive-cli.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'interactive-cli.wait-and-input',
        'Waits for prompts and then sends input deliberately.',
        ['/\\bwait\\b/i', '/\\b(?:type|input|paste|send-keys|run)\\b/i'],
        [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'wait-for-output',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      "I need to wait until my server prints 'Listening on port 3000' before running tests",
    expectedSkill: 'agent-tty',
    context:
      'The answer should prefer waiting on observable terminal text over fixed delays before starting the next step.',
    expectedPatterns: ['/agent-tty/i', '/\\bwait\\b/i'],
    forbiddenPatterns: [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i'],
    rubric: [
      'Chooses agent-tty for terminal readiness coordination.',
      'Uses wait against concrete terminal output instead of fixed timing guesses.',
    ],
    workflowChecks: [
      requiredCheck(
        'wait-for-output.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'wait-for-output.observe-readiness',
        'Waits for the listening message before running tests.',
        ['/\\bwait\\b/i', '/Listening on port 3000/i'],
        [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'snapshot-inspection',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Take a snapshot of what the terminal currently shows and check if the build succeeded',
    expectedSkill: 'agent-tty',
    context:
      'The answer should inspect the current terminal state directly instead of relying on generic shell multiplexers.',
    expectedPatterns: ['/agent-tty/i', '/\\bsnapshot\\b/i'],
    forbiddenPatterns: [
      TMUX_RECOMMENDATION_PATTERN,
      SCREEN_RECOMMENDATION_PATTERN,
    ],
    rubric: [
      'Selects agent-tty for terminal-state inspection.',
      'Uses snapshot as the inspection primitive before deciding whether the build passed.',
    ],
    workflowChecks: [
      requiredCheck(
        'snapshot-inspection.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'snapshot-inspection.capture-snapshot',
        'Captures a snapshot and uses it to inspect build status.',
        ['/\\bsnapshot\\b/i', '/\\b(?:check|inspect|verify)\\b/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'screenshot-capture',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Capture a screenshot of this TUI application for the PR review',
    expectedSkill: 'agent-tty',
    context:
      'The answer should use the built-in terminal screenshot workflow rather than ad hoc desktop capture tools.',
    expectedPatterns: ['/agent-tty/i', '/\\bscreenshot\\b/i'],
    forbiddenPatterns: [
      '/\\bscrot\\b/i',
      '/\\bimport\\b.*screenshot/i',
      '/xdotool/i',
    ],
    rubric: [
      'Recognizes this as a terminal/TUI artifact-capture task.',
      'Uses agent-tty screenshot for PR-review evidence instead of desktop tools.',
    ],
    workflowChecks: [
      requiredCheck(
        'screenshot-capture.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'screenshot-capture.capture-proof',
        'Captures a screenshot as reviewable proof.',
        ['/\\bscreenshot\\b/i', '/\\b(?:review|proof|artifact|PR)\\b/i'],
        ['/\\bscrot\\b/i', '/xdotool/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'recording-export',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Record the terminal session and export it as a video I can share',
    expectedSkill: 'agent-tty',
    context:
      'The answer should use built-in session recording and export artifacts instead of separate screen-recording tools.',
    expectedPatterns: [
      '/agent-tty/i',
      '/\\brecord\\b/i',
      '/\\b(?:export|webm|cast)\\b/i',
    ],
    forbiddenPatterns: ['/\\bffmpeg\\b/i', '/\\basciinema\\b/i'],
    rubric: [
      'Routes the task to agent-tty for recordable terminal automation.',
      'Mentions recording plus export to a shareable artifact such as WebM or cast.',
    ],
    workflowChecks: [
      requiredCheck(
        'recording-export.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'recording-export.export-artifact',
        'Uses the record export workflow to produce a shareable artifact.',
        ['/\\brecord\\b/i', '/\\b(?:export|webm|cast)\\b/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'cli-workflow-test',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Test my CLI tool by running several commands in sequence and verifying the output at each step',
    expectedSkill: 'agent-tty',
    context:
      'The response should propose a terminal workflow that runs commands and verifies output incrementally without brittle sleeps.',
    expectedPatterns: ['/agent-tty/i', '/\\b(?:run|wait|snapshot)\\b/i'],
    forbiddenPatterns: [
      SLEEP_RECOMMENDATION_PATTERN,
      TMUX_RECOMMENDATION_PATTERN,
    ],
    rubric: [
      'Recognizes the need for an automated terminal workflow.',
      'Uses agent-tty commands to run steps and verify output after each command.',
    ],
    workflowChecks: [
      requiredCheck(
        'cli-workflow-test.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'cli-workflow-test.run-and-verify',
        'Runs commands and verifies the output between steps.',
        ['/\\brun\\b/i', '/\\b(?:wait|snapshot|verify)\\b/i'],
        ['/sleep \\d+/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'resize-verification',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Check that my TUI app handles terminal resize correctly — resize the terminal and verify the layout updates',
    expectedSkill: 'agent-tty',
    context:
      'A correct plan should use terminal-aware resize automation and verification rather than manual guessing.',
    expectedPatterns: ['/agent-tty/i', '/\\bresize\\b/i'],
    forbiddenPatterns: [
      SLEEP_RECOMMENDATION_PATTERN,
      TMUX_RECOMMENDATION_PATTERN,
    ],
    rubric: [
      'Selects agent-tty for resize-sensitive TUI validation.',
      'Mentions resizing the terminal and verifying the resulting layout update.',
    ],
    workflowChecks: [
      requiredCheck(
        'resize-verification.select-agent-tty',
        'Explicitly selects agent-tty.',
        ['/agent-tty/i'],
      ),
      requiredCheck(
        'resize-verification.resize-and-check',
        'Resizes the terminal and verifies the updated layout.',
        [
          '/\\bresize\\b/i',
          '/\\b(?:layout|verify|snapshot|screenshot|update)\\b/i',
        ],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
];
