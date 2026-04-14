import { PromptEvalCaseSchema } from '../../lib/schemas.js';
import type { PromptEvalCase } from '../../lib/types.js';

const PROMPT_TIMEOUT_MS = 30_000;
const EMPTY_ANTI_PATTERNS: PromptEvalCase['antiPatterns'] = [];
const NO_TERMINAL_AUTOMATION_PATTERNS = ['/agent-tty/i', '/terminal session/i'];

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

export const SHOULD_NOT_TRIGGER_PROMPT_CASES: PromptEvalCase[] = [
  parseCase({
    id: 'pure-reasoning',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Explain how process scheduling works in Linux',
    expectedSkill: 'none',
    context:
      'This is a pure reasoning and explanation request with no need for terminal automation or QA-specific skills.',
    expectedPatterns: ['/\\b(?:scheduling|process|kernel)\\b/i'],
    forbiddenPatterns: NO_TERMINAL_AUTOMATION_PATTERNS,
    rubric: [
      'Answers the Linux scheduling question directly.',
      'Does not route the task into agent-tty or terminal-session setup.',
    ],
    workflowChecks: [
      requiredCheck(
        'pure-reasoning.stay-topical',
        'Stays focused on Linux scheduling concepts.',
        ['/\\b(?:scheduling|process|kernel)\\b/i'],
        NO_TERMINAL_AUTOMATION_PATTERNS,
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'code-review',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Review this Python function for correctness and suggest improvements',
    expectedSkill: 'none',
    context:
      'A direct code-review answer is appropriate; terminal automation would be unnecessary scope creep.',
    expectedPatterns: [
      '/\\b(?:review|correctness|improvement)\\b/i',
      '/\\b(?:Python|function|bug|edge case)\\b/i',
    ],
    forbiddenPatterns: [
      '/agent-tty/i',
      '/create.*session/i',
      '/terminal.*automation/i',
    ],
    rubric: [
      'Performs or proposes a direct code review of the Python function.',
      'Avoids creating a terminal-session workflow for a reasoning/editing task.',
    ],
    workflowChecks: [
      requiredCheck(
        'code-review.stay-topical',
        'Keeps the answer focused on Python correctness and improvements.',
        [
          '/\\b(?:review|correctness|improvement)\\b/i',
          '/\\b(?:Python|function)\\b/i',
        ],
        ['/agent-tty/i', '/terminal.*automation/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'file-editing',
    lane: 'prompt',
    category: 'trigger',
    prompt:
      'Add error handling to the database connection function in src/db.ts',
    expectedSkill: 'none',
    context:
      'This is a targeted code-editing request, so the right response is implementation guidance rather than terminal tooling selection.',
    expectedPatterns: [
      '/\\b(?:error handling|exception|retry|fallback)\\b/i',
      '/\\b(?:database|connection|src\\/db\\.ts)\\b/i',
    ],
    forbiddenPatterns: NO_TERMINAL_AUTOMATION_PATTERNS,
    rubric: [
      'Focuses on adding robust error handling to the database connection path.',
      'Does not suggest a terminal-session workflow for a file edit.',
    ],
    workflowChecks: [
      requiredCheck(
        'file-editing.stay-topical',
        'Keeps the answer focused on database error handling.',
        [
          '/\\b(?:error handling|exception|retry|fallback)\\b/i',
          '/\\b(?:database|connection)\\b/i',
        ],
        NO_TERMINAL_AUTOMATION_PATTERNS,
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'web-development',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Create a React component that displays a paginated table',
    expectedSkill: 'none',
    context:
      'The task is ordinary web-development implementation work, not terminal or TUI automation.',
    expectedPatterns: [
      '/\\b(?:React|component|paginated|table)\\b/i',
      '/\\b(?:props|state|page)\\b/i',
    ],
    forbiddenPatterns: NO_TERMINAL_AUTOMATION_PATTERNS,
    rubric: [
      'Responds as a React implementation task.',
      'Avoids routing the task to terminal automation.',
    ],
    workflowChecks: [
      requiredCheck(
        'web-development.stay-topical',
        'Keeps the answer focused on the React table implementation.',
        ['/\\b(?:React|component|paginated|table)\\b/i'],
        NO_TERMINAL_AUTOMATION_PATTERNS,
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'documentation',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Write API documentation for the user authentication module',
    expectedSkill: 'none',
    context:
      'This is a documentation-writing request, so the answer should stay in writing mode and skip terminal tooling.',
    expectedPatterns: [
      '/\\b(?:API|documentation|authentication|module)\\b/i',
      '/\\b(?:endpoint|parameter|return|usage)\\b/i',
    ],
    forbiddenPatterns: NO_TERMINAL_AUTOMATION_PATTERNS,
    rubric: [
      'Treats the request as documentation work.',
      'Does not introduce terminal automation or session creation.',
    ],
    workflowChecks: [
      requiredCheck(
        'documentation.stay-topical',
        'Keeps the answer focused on API documentation concerns.',
        ['/\\b(?:API|documentation|authentication|module)\\b/i'],
        NO_TERMINAL_AUTOMATION_PATTERNS,
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
  parseCase({
    id: 'git-operations',
    lane: 'prompt',
    category: 'trigger',
    prompt: 'Rebase my feature branch onto main and resolve the conflicts',
    expectedSkill: 'none',
    context:
      'This is a direct Git-operation request; it should stay focused on Git conflict resolution instead of special terminal tooling.',
    expectedPatterns: [
      '/\\b(?:rebase|feature branch|main)\\b/i',
      '/\\b(?:conflict|resolve)\\b/i',
    ],
    forbiddenPatterns: ['/agent-tty/i'],
    rubric: [
      'Keeps the answer centered on the Git rebase and conflict-resolution task.',
      'Avoids invoking agent-tty for a standard Git workflow request.',
    ],
    workflowChecks: [
      requiredCheck(
        'git-operations.stay-topical',
        'Keeps the answer focused on rebase conflict resolution.',
        [
          '/\\b(?:rebase|feature branch|main)\\b/i',
          '/\\b(?:conflict|resolve)\\b/i',
        ],
        ['/agent-tty/i'],
      ),
    ],
    antiPatterns: EMPTY_ANTI_PATTERNS,
    budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
  }),
];
