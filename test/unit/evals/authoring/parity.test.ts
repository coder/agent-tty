import { describe, expect, it } from 'vitest';

import exploratoryQaCase from '../../../../evals/dogfood/cases/exploratory-qa.js';
import { doctorGatedCase } from '../../../../evals/execution/cases/doctor-gated.js';
import { helloPromptCase } from '../../../../evals/execution/cases/hello-prompt.js';
import {
  DogfoodEvalCaseSchema,
  ExecutionEvalCaseSchema,
  PromptEvalCaseSchema,
} from '../../../../evals/lib/schemas.js';
import {
  TRIGGER_AGENT_TTY_PROMPT_CASES,
} from '../../../../evals/prompt/cases/trigger-agent-tty.js';
import type {
  AntiPatternRule,
  DogfoodEvalCase,
  ExecutionEvalCase,
  PromptEvalCase,
} from '../../../../evals/lib/types.js';

const PROCESS_EXEC_PATH_SENTINEL = '<process.execPath>';
const ALL_SKILL_CONDITIONS = ['none', 'self-load', 'preloaded', 'stale'] as const;
const HELLO_PROMPT_FIXTURE_ARGV = [
  '--import',
  'tsx',
  'test/fixtures/apps/hello-prompt/main.ts',
] as const;

const LEGACY_TERMINAL_ANTI_PATTERNS: AntiPatternRule[] = [
  {
    id: 'blind-sleep',
    severity: 'error',
    description:
      'Detected a blind sleep instead of waiting on terminal state or a specific condition.',
    patterns: [
      '(?:^|[;&|]\\s*)(sleep\\s+\\d+(?:\\.\\d+)?)\\b',
      '\\b(time\\.sleep\\s*\\(\\s*\\d+(?:\\.\\d+)?\\s*\\))',
    ],
    suggestedFix:
      'Replace blind sleeps with agent-tty wait, snapshot polling, or an explicit loop that checks for a real condition.',
  },
  {
    id: 'tmux-usage',
    severity: 'error',
    description:
      'Detected tmux usage instead of the supported agent-tty session workflow.',
    patterns: [
      '\\btmux\\b(?:\\s+(?:new(?:-session)?|attach(?:-session)?|kill-session|ls|list-sessions|new-window|split-window|send-keys)\\b)?',
    ],
    suggestedFix:
      'Use agent-tty run/create plus wait/snapshot/screenshot instead of tmux for long-lived terminal automation.',
  },
  {
    id: 'screen-usage',
    severity: 'error',
    description:
      'Detected screen usage instead of the supported agent-tty session workflow.',
    patterns: ['(?:^|[;&|]\\s*)(screen\\b(?:\\s+\\S+)?)'],
    suggestedFix:
      'Use agent-tty sessions and artifacts instead of screen for detached terminal execution.',
  },
  {
    id: 'adhoc-screenshot',
    severity: 'error',
    description:
      'Detected an ad hoc screenshot or desktop automation tool instead of agent-tty screenshot artifacts.',
    patterns: [
      '\\b(import\\s+-window)\\b',
      '\\b(scrot)\\b',
      '\\b(gnome-screenshot)\\b',
      '\\b(screencapture)\\b',
      '\\b(xdotool)\\b',
      '\\b(xwd)\\b',
    ],
    suggestedFix:
      'Capture reviewable terminal visuals with agent-tty screenshot or record export instead of ad hoc desktop tools.',
  },
  {
    id: 'missing-json-flag',
    severity: 'warning',
    description:
      'Detected an agent-tty invocation without --json, which makes automation less reliable.',
    patterns: ['\\bagent-tty\\b[^;&|\\n]*'],
    suggestedFix:
      'Add --json to agent-tty commands used in transcripts, evals, or automation so downstream parsing is stable.',
  },
  {
    id: 'orphaned-session',
    severity: 'warning',
    description:
      'Detected session creation evidence without matching agent-tty destroy/kill cleanup.',
    patterns: [
      '\\bagent-tty\\b[^\\n]*\\b(?:run|create)\\b',
      '\\bagent-tty\\b[^\\n]*\\b(?:destroy|kill)\\b',
      '\\bsession(?:_id|Id)\\b',
    ],
    suggestedFix:
      'Track created session IDs and destroy or kill them in teardown/finally blocks so eval runs do not leak sessions.',
  },
  {
    id: 'direct-manifest-write',
    severity: 'info',
    description:
      'Detected a direct manifest write instead of going through the validated storage helpers.',
    patterns: [
      '\\b((?:fs(?:\\.promises)?\\.)?writeFile(?:Sync)?\\s*\\([^)]*\\bmanifest[A-Za-z0-9_]*\\b[^)]*\\))',
      '\\b(writeFile(?:Sync)?\\s*\\([^)]*\\bmanifest[A-Za-z0-9_]*\\b[^)]*\\))',
    ],
    suggestedFix:
      'Write manifests through the storage helpers so path validation and schema guarantees stay centralized.',
  },
];

const LEGACY_WAIT_FOR_OUTPUT_CASE = PromptEvalCaseSchema.parse({
  id: 'wait-for-output',
  lane: 'prompt',
  category: 'trigger',
  prompt:
    "I need to wait until my server prints 'Listening on port 3000' before running tests",
  expectedSkill: 'agent-tty',
  context:
    'The answer should prefer waiting on observable terminal text over fixed delays before starting the next step.',
  expectedPatterns: ['/agent-tty/i', '/\\bwait\\b/i'],
  forbiddenPatterns: [
    '/(?:^|\\n)\\s*sleep\\s+\\d+(?:\\.\\d+)?\\b|(?:(?<=\\buse\\s)|(?<=\\brun\\s)|(?<=\\badd\\s)|(?<=\\binsert\\s))sleep\\s+\\d+(?:\\.\\d+)?\\b/i',
    '/setTimeout/i',
  ],
  rubric: [
    'Chooses agent-tty for terminal readiness coordination.',
    'Uses wait against concrete terminal output instead of fixed timing guesses.',
  ],
  workflowChecks: [
    {
      id: 'wait-for-output.select-agent-tty',
      description: 'Explicitly selects agent-tty.',
      required: true,
      requiredPatterns: ['/agent-tty/i'],
      forbiddenPatterns: [],
      dependsOn: [],
    },
    {
      id: 'wait-for-output.observe-readiness',
      description: 'Waits for the listening message before running tests.',
      required: true,
      requiredPatterns: ['/\\bwait\\b/i', '/Listening on port 3000/i'],
      forbiddenPatterns: [
        '/(?:^|\\n)\\s*sleep\\s+\\d+(?:\\.\\d+)?\\b|(?:(?<=\\buse\\s)|(?<=\\brun\\s)|(?<=\\badd\\s)|(?<=\\binsert\\s))sleep\\s+\\d+(?:\\.\\d+)?\\b/i',
        '/setTimeout/i',
      ],
      dependsOn: [],
    },
  ],
  antiPatterns: [],
  budgets: {
    timeoutMs: 30_000,
  },
}) as PromptEvalCase;

const LEGACY_HELLO_PROMPT_CASE = ExecutionEvalCaseSchema.parse({
  id: 'hello-prompt',
  lane: 'execution',
  category: 'session',
  prompt:
    'ACTUALLY PERFORM this task by running agent-tty CLI commands via `npx tsx src/cli/main.ts`; do not just describe the steps. Use the isolated `AGENT_TTY_HOME` provided for this eval so session state stays contained. Use the repository fixture app `hello-prompt` from `test/fixtures/apps/hello-prompt/main.ts` via the provided setup command. Launch the hello-prompt fixture, send \'hello world\' as input, wait for the READY> prompt to reappear, take a snapshot to verify the echo, then destroy the session.',
  expectedSkill: 'agent-tty',
  conditions: [...ALL_SKILL_CONDITIONS],
  setup: [
    {
      id: 'launch-hello-prompt',
      description:
        'Create an agent-tty session that runs the hello-prompt fixture.',
      command: PROCESS_EXEC_PATH_SENTINEL,
      argv: [...HELLO_PROMPT_FIXTURE_ARGV],
      timeoutMs: 30_000,
    },
  ],
  verifiers: [
    {
      id: 'hello-prompt-snapshot',
      kind: 'snapshot',
      description:
        'The transcript snapshot should include the echoed text and the READY prompt.',
      required: true,
      config: {
        patterns: ['ECHO:\\s*hello world', 'READY>'],
      },
    },
  ],
  workflowChecks: [
    {
      id: 'create',
      description: 'Create the fixture session.',
      required: false,
      requiredPatterns: [
        '(?:\\bagent-tty\\b[^\\n]*\\bcreate\\b|\\bcreate(?:d|ing)?\\b[^\\n]*\\bsession\\b)',
      ],
      forbiddenPatterns: [],
      dependsOn: [],
    },
    {
      id: 'input',
      description: 'Send hello world with run or type.',
      required: false,
      requiredPatterns: [
        '(?:\\bagent-tty\\b[^\\n]*\\b(?:run|type)\\b[^\\n]*hello world|\\b(?:run|type)(?:ning|s|ned)?\\b[^\\n]*hello world\\b|ECHO:\\s*hello world)',
      ],
      forbiddenPatterns: [],
      dependsOn: ['create'],
    },
    {
      id: 'wait',
      description: 'Wait for the READY prompt to reappear after the echo.',
      required: false,
      requiredPatterns: [
        '(?:(?:\\bagent-tty\\b[^\\n]*\\bwait\\b|\\bwait(?:ed|ing)?\\b)|ECHO:\\s*hello world[\\s\\S]*READY>)',
      ],
      forbiddenPatterns: [],
      dependsOn: ['input'],
    },
    {
      id: 'snapshot',
      description: 'Capture a snapshot for verification.',
      required: false,
      requiredPatterns: [
        '(?:\\bagent-tty\\b[^\\n]*\\bsnapshot\\b|\\bsnapshot(?:ed|ting)?\\b)',
      ],
      forbiddenPatterns: [],
      dependsOn: ['wait'],
    },
    {
      id: 'destroy',
      description: 'Destroy the session after verification.',
      required: false,
      requiredPatterns: [
        '(?:\\bagent-tty\\b[^\\n]*\\b(?:destroy|kill)\\b|\\b(?:destroy|kill|cleanup)(?:ed|ing)?\\b[^\\n]*\\bsession\\b)',
      ],
      forbiddenPatterns: [],
      dependsOn: ['snapshot'],
    },
  ],
  antiPatterns: LEGACY_TERMINAL_ANTI_PATTERNS,
  artifactRequirements: [],
  budgets: {
    timeoutMs: 120_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  },
  fixture: 'hello-prompt',
  referenceSteps: 5,
}) as ExecutionEvalCase;

const LEGACY_DOCTOR_GATED_CASE = ExecutionEvalCaseSchema.parse({
  id: 'doctor-gated',
  lane: 'execution',
  category: 'artifact',
  prompt:
    'ACTUALLY PERFORM this task by running agent-tty CLI commands via `npx tsx src/cli/main.ts`; do not just describe the steps. Use the isolated `AGENT_TTY_HOME` provided for this eval so session state stays contained. Use the repository fixture app `hello-prompt` from `test/fixtures/apps/hello-prompt/main.ts` via the provided setup command. Before capturing a screenshot, run doctor --json to verify renderer prerequisites and then capture a screenshot of hello-prompt.',
  expectedSkill: 'agent-tty',
  conditions: [...ALL_SKILL_CONDITIONS],
  setup: [
    {
      id: 'launch-doctor-gated',
      description:
        'Create an agent-tty session that runs the hello-prompt fixture.',
      command: PROCESS_EXEC_PATH_SENTINEL,
      argv: [...HELLO_PROMPT_FIXTURE_ARGV],
      timeoutMs: 30_000,
    },
  ],
  verifiers: [
    {
      id: 'doctor-gated-screenshot',
      kind: 'screenshot',
      description:
        'A screenshot artifact should be produced after the doctor check passes.',
      required: true,
      config: {
        kind: 'screenshot',
      },
    },
  ],
  workflowChecks: [
    {
      id: 'create',
      description: 'Create the fixture session.',
      required: false,
      requiredPatterns: [
        '(?:\\bagent-tty\\b[^\\n]*\\bcreate\\b|\\bcreate(?:d|ing)?\\b[^\\n]*\\bsession\\b)',
      ],
      forbiddenPatterns: [],
      dependsOn: [],
    },
    {
      id: 'doctor',
      description: 'Run doctor --json before any renderer-dependent capture.',
      required: false,
      requiredPatterns: [
        '(?:\\bagent-tty\\b[^\\n]*\\bdoctor\\b[^\\n]*--json\\b|\\bdoctor\\b[^\\n]*--json\\b)',
      ],
      forbiddenPatterns: [],
      dependsOn: ['create'],
    },
    {
      id: 'screenshot',
      description: 'Capture the screenshot only after the doctor gate.',
      required: false,
      requiredPatterns: [
        '(?:(?:\\bagent-tty\\b[^\\n]*\\bdoctor\\b[^\\n]*--json\\b|\\bdoctor\\b[^\\n]*--json\\b))[\\s\\S]*?(?:(?:\\bagent-tty\\b[^\\n]*\\bscreenshot\\b|\\bscreenshot(?:ed|ting)?\\b))',
      ],
      forbiddenPatterns: [],
      dependsOn: ['doctor'],
    },
  ],
  antiPatterns: LEGACY_TERMINAL_ANTI_PATTERNS,
  artifactRequirements: [
    {
      kind: 'screenshot',
      required: true,
      description: 'A PNG screenshot should be saved after the doctor check.',
      minCount: 1,
      pathPatterns: ['\\.png$'],
    },
  ],
  budgets: {
    timeoutMs: 180_000,
    maxAgentSteps: 14,
    maxWallClockMs: 75_000,
  },
  fixture: 'hello-prompt',
  referenceSteps: 5,
}) as ExecutionEvalCase;

const LEGACY_EXPLORATORY_QA_CASE = DogfoodEvalCaseSchema.parse({
  id: 'exploratory-qa',
  lane: 'dogfood',
  category: 'qa',
  prompt:
    'ACTUALLY PERFORM this dogfood task by running agent-tty CLI commands via `npx tsx src/cli/main.ts`; do not only describe what you would test. Use the isolated `AGENT_TTY_HOME` provided for this eval so session state and artifacts stay contained. Target the repository fixture app `hello-prompt` from `test/fixtures/apps/hello-prompt/main.ts` for this investigation. Capture the requested evidence bundle artifacts in the provided proof-bundle directory, including screenshots, recordings, snapshots, WebM exports, and structured notes whenever the case requires them. Launch the hello-prompt fixture, test exactly three inputs (`hello world`, a blank line, and `symbols-!@#$%^&*`), capture a snapshot after each input, then send `exit` to verify clean shutdown. Save at least one screenshot and one recording, and write a brief findings report with severity and evidence references.',
  expectedSkill: 'dogfood-tui',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a reviewable proof bundle for an exploratory QA investigation.',
    'Capture renderer-backed evidence for the tested interactions and edge cases.',
    'Write structured notes that summarize findings, severity, and evidence references.',
  ],
  conditions: [...ALL_SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    {
      kind: 'screenshot',
      required: true,
      description: 'Capture at least one screenshot of a noteworthy state.',
      minCount: 1,
      pathPatterns: ['\\.png$'],
    },
    {
      kind: 'recording',
      required: true,
      description: 'Capture at least one terminal recording artifact.',
      minCount: 1,
      pathPatterns: ['\\.cast$'],
    },
    {
      kind: 'notes',
      required: true,
      description: 'Write exploratory QA notes in a markdown report.',
      minCount: 1,
      pathPatterns: ['(?:^|/)(?:README|NOTES|index|notes)\\.md$'],
    },
  ],
  reportRequirements: [
    {
      id: 'title',
      description: 'Report must have a descriptive title.',
      required: true,
      section: 'Title',
      requiredPatterns: [
        '/(?:^|\\n)\\s*(?:#{1,3}\\s*Title\\b|\\*\\*Title:?\\*\\*)/im',
      ],
      forbiddenPatterns: [],
    },
    {
      id: 'repro-steps',
      description: 'Include step-by-step reproduction commands.',
      required: true,
      section: 'Reproduction steps',
      requiredPatterns: [
        '/(?:^|\\n)\\s*(?:#{1,3}\\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\\b|\\*\\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\\*\\*)/im',
        '/\\b(?:agent-tty|npx\\s+tsx\\s+src\\/cli\\/main\\.ts)\\b/i',
      ],
      forbiddenPatterns: [],
    },
    {
      id: 'findings',
      description: 'List findings with severity classification.',
      required: true,
      section: 'Findings',
      requiredPatterns: [
        '/(?:^|\\n)\\s*(?:#{1,3}\\s*(?:Findings|Issues)\\b|\\*\\*(?:Findings|Issues):?\\*\\*)/im',
        '/\\b(?:severity|critical|high|medium|low|info)\\b/i',
      ],
      forbiddenPatterns: [],
    },
    {
      id: 'evidence',
      description:
        'Reference captured artifacts such as screenshots and recordings.',
      required: true,
      section: 'Evidence',
      requiredPatterns: [
        '/(?:^|\\n)\\s*(?:#{1,3}\\s*Evidence\\b|\\*\\*Evidence:?\\*\\*)/im',
        '/\\.(?:png|cast|webm|json|md)\\b/i',
      ],
      forbiddenPatterns: [],
    },
  ],
  verifiers: [
    {
      id: 'bundle-valid',
      kind: 'bundle',
      description:
        'Validate the exploratory QA proof bundle with the interactive renderer profile.',
      required: true,
      config: {
        profile: 'interactive-renderer',
      },
    },
  ],
  workflowChecks: [],
  antiPatterns: LEGACY_TERMINAL_ANTI_PATTERNS,
  budgets: {
    timeoutMs: 600_000,
    maxAgentSteps: 30,
    maxWallClockMs: 600_000,
  },
  fixture: 'hello-prompt',
}) as DogfoodEvalCase;

function findPromptCaseOrThrow(caseId: string): PromptEvalCase {
  const evalCase = TRIGGER_AGENT_TTY_PROMPT_CASES.find(
    (candidate) => candidate.id === caseId,
  );
  if (evalCase === undefined) {
    throw new Error(`Expected prompt case ${caseId} to be registered`);
  }
  return evalCase;
}

function normalizeRuntimeShape<T extends PromptEvalCase | ExecutionEvalCase | DogfoodEvalCase>(
  evalCase: T,
): T {
  const normalized = structuredClone(evalCase);
  if ('setup' in normalized) {
    normalized.setup = normalized.setup.map((step) => ({
      ...step,
      // fixtureSetupStep() uses process.execPath, which varies across dev and CI Node installations.
      command: PROCESS_EXEC_PATH_SENTINEL,
    }));
  }
  return normalized;
}

describe('authoring facade legacy parity', () => {
  it('preserves the legacy wait-for-output prompt case runtime shape', () => {
    const current = PromptEvalCaseSchema.parse(
      findPromptCaseOrThrow('wait-for-output'),
    ) as PromptEvalCase;

    expect(normalizeRuntimeShape(current)).toEqual(LEGACY_WAIT_FOR_OUTPUT_CASE);
  });

  it('preserves the legacy hello-prompt execution case runtime shape', () => {
    const current = ExecutionEvalCaseSchema.parse(
      helloPromptCase,
    ) as ExecutionEvalCase;

    expect(normalizeRuntimeShape(current)).toEqual(LEGACY_HELLO_PROMPT_CASE);
  });

  it('preserves the legacy doctor-gated execution case runtime shape', () => {
    const current = ExecutionEvalCaseSchema.parse(
      doctorGatedCase,
    ) as ExecutionEvalCase;

    expect(normalizeRuntimeShape(current)).toEqual(LEGACY_DOCTOR_GATED_CASE);
  });

  it('preserves the legacy exploratory-qa dogfood case runtime shape', () => {
    const current = DogfoodEvalCaseSchema.parse(
      exploratoryQaCase,
    ) as DogfoodEvalCase;

    expect(normalizeRuntimeShape(current)).toEqual(LEGACY_EXPLORATORY_QA_CASE);
  });
});
