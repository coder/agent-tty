import { assertString, invariant } from '../../src/util/assert.js';
import { isInNegationContext } from './scoring.js';
import type {
  AntiPatternFinding,
  AntiPatternRule,
  AntiPatternSeverity,
} from './types.js';

const SEVERITY_ORDER: Record<AntiPatternSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const COMMENT_ONLY_LINE_PATTERN = /^\s*(?:#|\/\/|\/\*|\*|\*\/|<!--)/u;
const BLIND_SLEEP_CONTEXT_PATTERN =
  /\b(?:while|until|for|do|done|retry|poll|watch|loop)\b/iu;
const FENCED_CODE_BLOCK_PATTERN = /^\s*```/u;
const COMMAND_PROMPT_PREFIX_PATTERN = /^\s*(?:[$>])\s*/u;
const AGENT_TTY_COMMAND_TEXT_PATTERN = String.raw`(?:agent-tty\b|npx\s+tsx\b[^\n]*?\bsrc\/cli\/main\.ts\b)`;
const AGENT_TTY_SEGMENT_PATTERN = new RegExp(
  String.raw`${AGENT_TTY_COMMAND_TEXT_PATTERN}[^;&|\n]*`,
  'giu',
);
const AGENT_TTY_SUBCOMMAND_PATTERN = new RegExp(
  String.raw`^\s*${AGENT_TTY_COMMAND_TEXT_PATTERN}(?:\s+--?[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?)*\s+[A-Za-z][\w-]*`,
  'iu',
);
const AGENT_TTY_SUBCOMMAND_NAME_PATTERN = new RegExp(
  String.raw`${AGENT_TTY_COMMAND_TEXT_PATTERN}(?:\s+--?[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?)*\s+([A-Za-z][\w-]*)`,
  'iu',
);
const COMMAND_LIKE_LINE_PATTERN = new RegExp(
  String.raw`^\s*(?:[$>]\s*)?(?:agent-tty\b|npx\s+tsx\b)`,
  'iu',
);
const AGENT_TTY_JSON_FLAG_PATTERN = /(?:^|\s)--json(?:\s|$|=)/iu;
const SESSION_CREATE_CONTEXT_PATTERN = new RegExp(
  String.raw`${AGENT_TTY_COMMAND_TEXT_PATTERN}[^\n]*\b(?:run|create)\b`,
  'iu',
);
const SESSION_DESTROY_CONTEXT_PATTERN = new RegExp(
  String.raw`${AGENT_TTY_COMMAND_TEXT_PATTERN}[^\n]*\b(?:destroy|kill)\b`,
  'iu',
);
const SESSION_ID_PATTERNS = [
  /\bsession_id\b\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]*)["']?/giu,
  /\bsessionId\b\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]*)["']?/gu,
  /\bSession ID\b\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]*)["']?/giu,
  /--session(?:-id)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\b/gu,
] as const;
const NEGATION_AWARE_RULE_IDS = new Set<string>([
  'blind-sleep',
  'tmux-usage',
  'screen-usage',
  'adhoc-screenshot',
]);
const STRUCTURED_SESSION_REFERENCE_LINE_PATTERN =
  /^\s*(?:\{|\[|["']?session(?:_id|Id)["']?\s*[:=]|Session ID\s*[:=]|--session(?:-id)?\s+)/u;

/**
 * Canonical transcript anti-pattern rules for terminal automation evals.
 */
export const DEFAULT_ANTI_PATTERN_RULES: readonly AntiPatternRule[] = [
  {
    id: 'blind-sleep',
    severity: 'error',
    description:
      'Detected a blind sleep instead of waiting on terminal state or a specific condition.',
    patterns: [
      String.raw`(?:^|[;&|]\s*)(sleep\s+\d+(?:\.\d+)?)\b`,
      String.raw`\b(time\.sleep\s*\(\s*\d+(?:\.\d+)?\s*\))`,
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
      String.raw`\btmux\b(?:\s+(?:new(?:-session)?|attach(?:-session)?|kill-session|ls|list-sessions|new-window|split-window|send-keys)\b)?`,
    ],
    suggestedFix:
      'Use agent-tty run/create plus wait/snapshot/screenshot instead of tmux for long-lived terminal automation.',
  },
  {
    id: 'screen-usage',
    severity: 'error',
    description:
      'Detected screen usage instead of the supported agent-tty session workflow.',
    patterns: [String.raw`(?:^|[;&|]\s*)(screen\b(?:\s+\S+)?)`],
    suggestedFix:
      'Use agent-tty sessions and artifacts instead of screen for detached terminal execution.',
  },
  {
    id: 'adhoc-screenshot',
    severity: 'error',
    description:
      'Detected an ad hoc screenshot or desktop automation tool instead of agent-tty screenshot artifacts.',
    patterns: [
      String.raw`\b(import\s+-window)\b`,
      String.raw`\b(scrot)\b`,
      String.raw`\b(gnome-screenshot)\b`,
      String.raw`\b(screencapture)\b`,
      String.raw`\b(xdotool)\b`,
      String.raw`\b(xwd)\b`,
    ],
    suggestedFix:
      'Capture reviewable terminal visuals with agent-tty screenshot or record export instead of ad hoc desktop tools.',
  },
  {
    id: 'missing-json-flag',
    severity: 'warning',
    description:
      'Detected an agent-tty invocation without --json, which makes automation less reliable.',
    patterns: [String.raw`\bagent-tty\b[^;&|\n]*`],
    suggestedFix:
      'Add --json to agent-tty commands used in transcripts, evals, or automation so downstream parsing is stable.',
  },
  {
    id: 'orphaned-session',
    severity: 'warning',
    description:
      'Detected session creation evidence without matching agent-tty destroy/kill cleanup.',
    patterns: [
      String.raw`\bagent-tty\b[^\n]*\b(?:run|create)\b`,
      String.raw`\bagent-tty\b[^\n]*\b(?:destroy|kill)\b`,
      String.raw`\bsession(?:_id|Id)\b`,
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
      String.raw`\b((?:fs(?:\.promises)?\.)?writeFile(?:Sync)?\s*\([^)]*\bmanifest[A-Za-z0-9_]*\b[^)]*\))`,
      String.raw`\b(writeFile(?:Sync)?\s*\([^)]*\bmanifest[A-Za-z0-9_]*\b[^)]*\))`,
    ],
    suggestedFix:
      'Write manifests through the storage helpers so path validation and schema guarantees stay centralized.',
  },
];

validateRules(DEFAULT_ANTI_PATTERN_RULES);

/**
 * Compile an anti-pattern regex for transcript line scanning.
 */
export function compileAntiPatternRegex(pattern: string): RegExp {
  assertString(pattern, 'anti-pattern pattern must be a string');
  invariant(
    pattern.trim().length > 0,
    'anti-pattern pattern must not be empty',
  );

  try {
    return new RegExp(pattern, 'gi');
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'unknown regular expression error';
    throw new Error(
      `Invalid anti-pattern regex pattern "${pattern}": ${message}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Detect transcript anti-pattern findings using the provided rules.
 */
export function detectAntiPatterns(
  transcript: string,
  rules: readonly AntiPatternRule[] = DEFAULT_ANTI_PATTERN_RULES,
): AntiPatternFinding[] {
  assertString(transcript, 'transcript must be a string');
  validateRules(rules);

  const findings: AntiPatternFinding[] = [];
  const seenFindingKeys = new Set<string>();
  const compiledPatterns = compileRules(rules);
  const orphanedSessionRule = rules.find(
    (rule) => rule.id === 'orphaned-session',
  );
  const missingJsonFlagRule = rules.find(
    (rule) => rule.id === 'missing-json-flag',
  );
  const lines = transcript.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    if (isCommentOnlyLine(line)) {
      continue;
    }

    const lineNumber = index + 1;

    for (const rule of rules) {
      if (rule.id === 'orphaned-session' || rule.id === 'missing-json-flag') {
        continue;
      }

      if (rule.id === 'blind-sleep') {
        addBlindSleepFindings(
          findings,
          seenFindingKeys,
          rule,
          line,
          lineNumber,
          compiledPatterns.get(rule.id) ?? [],
        );
        continue;
      }

      addRegexFindings(
        findings,
        seenFindingKeys,
        rule,
        line,
        lineNumber,
        compiledPatterns.get(rule.id) ?? [],
      );
    }
  }

  if (orphanedSessionRule) {
    for (const finding of detectOrphanedSessions(
      transcript,
      orphanedSessionRule,
    )) {
      addFinding(findings, seenFindingKeys, finding);
    }
  }

  if (missingJsonFlagRule) {
    addMissingJsonFlagFinding(
      findings,
      seenFindingKeys,
      missingJsonFlagRule,
      transcript,
    );
  }

  return findings.sort((left, right) => {
    const leftLine = left.lineNumber ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.lineNumber ?? Number.MAX_SAFE_INTEGER;

    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }

    return left.ruleId.localeCompare(right.ruleId);
  });
}

/**
 * Filter anti-pattern rules to a minimum severity threshold.
 */
export function filterRulesBySeverity(
  rules: readonly AntiPatternRule[],
  minSeverity: AntiPatternSeverity,
): AntiPatternRule[] {
  invariant(
    minSeverity in SEVERITY_ORDER,
    `unknown anti-pattern severity: ${minSeverity}`,
  );
  validateRules(rules);

  const minimumRank = SEVERITY_ORDER[minSeverity];
  return rules.filter((rule) => SEVERITY_ORDER[rule.severity] >= minimumRank);
}

/**
 * Summarize findings by total count, rule, and severity.
 */
export function summarizeFindings(findings: readonly AntiPatternFinding[]): {
  total: number;
  byRule: Record<string, number>;
  bySeverity: Record<AntiPatternSeverity, number>;
} {
  const byRule: Record<string, number> = {};
  const bySeverity: Record<AntiPatternSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
  };

  for (const finding of findings) {
    invariant(
      finding.severity in SEVERITY_ORDER,
      `unknown anti-pattern severity: ${finding.severity}`,
    );

    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    bySeverity[finding.severity] += 1;
  }

  return {
    total: findings.length,
    byRule,
    bySeverity,
  };
}

function validateRules(rules: readonly AntiPatternRule[]): void {
  const seenRuleIds = new Set<string>();

  for (const rule of rules) {
    assertString(rule.id, 'anti-pattern rule id must be a string');
    invariant(
      rule.id.trim().length > 0,
      'anti-pattern rule id must not be empty',
    );
    assertString(
      rule.description,
      `anti-pattern rule ${rule.id} must have a description`,
    );
    invariant(
      rule.description.trim().length > 0,
      `anti-pattern rule ${rule.id} must have a non-empty description`,
    );
    assertString(
      rule.suggestedFix,
      `anti-pattern rule ${rule.id} must have a suggestedFix`,
    );
    invariant(
      rule.suggestedFix.trim().length > 0,
      `anti-pattern rule ${rule.id} must have a non-empty suggestedFix`,
    );
    invariant(
      rule.severity in SEVERITY_ORDER,
      `anti-pattern rule ${rule.id} has unknown severity ${rule.severity}`,
    );
    invariant(
      rule.patterns.length > 0,
      `anti-pattern rule ${rule.id} must define at least one pattern`,
    );
    invariant(
      !seenRuleIds.has(rule.id),
      `anti-pattern rule ids must be unique; duplicate id ${rule.id}`,
    );

    seenRuleIds.add(rule.id);

    for (const pattern of rule.patterns) {
      compileAntiPatternRegex(pattern);
    }
  }
}

function compileRules(
  rules: readonly AntiPatternRule[],
): Map<string, RegExp[]> {
  const compiled = new Map<string, RegExp[]>();

  for (const rule of rules) {
    compiled.set(
      rule.id,
      rule.patterns.map((pattern) => compileAntiPatternRegex(pattern)),
    );
  }

  return compiled;
}

function isCommentOnlyLine(line: string): boolean {
  return COMMENT_ONLY_LINE_PATTERN.test(line);
}

function isCodeFenceBoundary(line: string): boolean {
  return FENCED_CODE_BLOCK_PATTERN.test(line);
}

function isCommandLikeLine(line: string, inFencedCodeBlock: boolean): boolean {
  return (
    inFencedCodeBlock ||
    COMMAND_PROMPT_PREFIX_PATTERN.test(line) ||
    COMMAND_LIKE_LINE_PATTERN.test(line)
  );
}

function describeCommandSegment(segment: string, lineNumber: number): string {
  const normalizedSegment = segment.replace(/\s+/gu, ' ').trim();
  AGENT_TTY_SUBCOMMAND_NAME_PATTERN.lastIndex = 0;
  const match = AGENT_TTY_SUBCOMMAND_NAME_PATTERN.exec(normalizedSegment);
  const commandName = match?.[1] ?? normalizedSegment;
  return `${commandName} (line ${String(lineNumber)})`;
}

function addBlindSleepFindings(
  findings: AntiPatternFinding[],
  seenFindingKeys: Set<string>,
  rule: AntiPatternRule,
  line: string,
  lineNumber: number,
  patterns: readonly RegExp[],
): void {
  if (BLIND_SLEEP_CONTEXT_PATTERN.test(line)) {
    return;
  }

  addRegexFindings(findings, seenFindingKeys, rule, line, lineNumber, patterns);
}

function addRegexFindings(
  findings: AntiPatternFinding[],
  seenFindingKeys: Set<string>,
  rule: AntiPatternRule,
  line: string,
  lineNumber: number,
  patterns: readonly RegExp[],
): void {
  for (const pattern of patterns) {
    for (const occurrence of collectMatches(line, pattern)) {
      addFinding(
        findings,
        seenFindingKeys,
        buildRegexFinding(rule, occurrence, line, lineNumber),
      );
    }
  }
}

function buildRegexFinding(
  rule: AntiPatternRule,
  occurrence: MatchedOccurrence,
  line: string,
  lineNumber: number,
): AntiPatternFinding {
  if (
    NEGATION_AWARE_RULE_IDS.has(rule.id) &&
    isInNegationContext(line, occurrence.offset)
  ) {
    return buildFinding(
      rule,
      occurrence.matchedText,
      lineNumber,
      `Matched "${occurrence.matchedText}" only in a negation context, so this anti-pattern was skipped.`,
      'info',
    );
  }

  return buildFinding(rule, occurrence.matchedText, lineNumber);
}

function addMissingJsonFlagFinding(
  findings: AntiPatternFinding[],
  seenFindingKeys: Set<string>,
  rule: AntiPatternRule,
  transcript: string,
): void {
  const commandSegments = collectAgentTtyCommandSegments(transcript);
  if (commandSegments.length === 0) {
    return;
  }

  const commandsWithJson = commandSegments.filter(({ segment }) =>
    AGENT_TTY_JSON_FLAG_PATTERN.test(segment),
  );
  const commandsMissingJson = commandSegments.filter(
    ({ segment }) => !AGENT_TTY_JSON_FLAG_PATTERN.test(segment),
  );
  if (commandsMissingJson.length === 0) {
    return;
  }

  const firstMissingCommand = commandsMissingJson[0];
  invariant(
    firstMissingCommand !== undefined,
    'missing-json-flag requires at least one agent-tty command segment',
  );
  const missingCommandList = commandsMissingJson
    .map(({ segment, lineNumber }) =>
      describeCommandSegment(segment, lineNumber),
    )
    .join(', ');
  const message =
    commandsWithJson.length > 0
      ? `Informational only: some agent-tty commands omitted --json even though other commands included it. Missing --json on ${missingCommandList}.`
      : `Detected agent-tty commands without any --json usage in the response. Missing --json on ${missingCommandList}.`;

  addFinding(
    findings,
    seenFindingKeys,
    buildFinding(
      rule,
      firstMissingCommand.segment,
      firstMissingCommand.lineNumber,
      message,
      commandsWithJson.length > 0 ? 'info' : rule.severity,
    ),
  );
}

type AgentTtyCommandSegment = {
  segment: string;
  lineNumber: number;
};

type MatchedOccurrence = {
  matchedText: string;
  offset: number;
};

function collectAgentTtyCommandSegments(
  transcript: string,
): AgentTtyCommandSegment[] {
  const commandSegments: AgentTtyCommandSegment[] = [];
  const lines = transcript.split(/\r?\n/u);
  let inFencedCodeBlock = false;

  for (const [index, line] of lines.entries()) {
    if (isCodeFenceBoundary(line)) {
      inFencedCodeBlock = !inFencedCodeBlock;
      continue;
    }

    if (
      isCommentOnlyLine(line) ||
      !isCommandLikeLine(line, inFencedCodeBlock)
    ) {
      continue;
    }

    AGENT_TTY_SEGMENT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null = AGENT_TTY_SEGMENT_PATTERN.exec(line);

    while (match !== null) {
      const segment = match[0].trim();
      AGENT_TTY_SUBCOMMAND_PATTERN.lastIndex = 0;
      if (AGENT_TTY_SUBCOMMAND_PATTERN.test(segment)) {
        commandSegments.push({
          segment,
          lineNumber: index + 1,
        });
      }

      if (match[0].length === 0) {
        AGENT_TTY_SEGMENT_PATTERN.lastIndex += 1;
      }

      match = AGENT_TTY_SEGMENT_PATTERN.exec(line);
    }
  }

  return commandSegments;
}

function collectMatches(line: string, pattern: RegExp): MatchedOccurrence[] {
  const matches: MatchedOccurrence[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(line);

  while (match !== null) {
    invariant(
      typeof match.index === 'number',
      'anti-pattern match index missing',
    );
    matches.push({
      matchedText: extractMatchedText(match),
      offset: match.index,
    });

    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }

    match = pattern.exec(line);
  }

  return matches;
}

function extractMatchedText(match: RegExpExecArray): string {
  for (let index = 1; index < match.length; index += 1) {
    const value = match[index];
    if (typeof value === 'string' && value.length > 0) {
      return value.trim();
    }
  }

  return match[0].trim();
}

function buildFinding(
  rule: AntiPatternRule,
  matchedText: string,
  lineNumber: number,
  message = rule.description,
  severity: AntiPatternSeverity = rule.severity,
): AntiPatternFinding {
  return {
    ruleId: rule.id,
    severity,
    message,
    matchedText,
    lineNumber,
    suggestedFix: rule.suggestedFix,
  };
}

function addFinding(
  findings: AntiPatternFinding[],
  seenFindingKeys: Set<string>,
  finding: AntiPatternFinding,
): void {
  const findingKey = [
    finding.ruleId,
    finding.severity,
    String(finding.lineNumber ?? ''),
    finding.matchedText ?? '',
  ].join(':');

  if (seenFindingKeys.has(findingKey)) {
    return;
  }

  seenFindingKeys.add(findingKey);
  findings.push(finding);
}

type SessionCreationRecord = {
  id?: string;
  lineNumber: number;
  matchedText: string;
  cleaned: boolean;
};

function detectOrphanedSessions(
  transcript: string,
  rule: AntiPatternRule,
): AntiPatternFinding[] {
  const records: SessionCreationRecord[] = [];
  const createdById = new Map<string, number>();
  const pendingAnonymousRecords: number[] = [];
  const pendingCleanupIds = new Set<string>();
  const lines = transcript.split(/\r?\n/u);
  let inFencedCodeBlock = false;

  for (const [index, line] of lines.entries()) {
    if (isCodeFenceBoundary(line)) {
      inFencedCodeBlock = !inFencedCodeBlock;
      continue;
    }

    if (isCommentOnlyLine(line)) {
      continue;
    }

    const lineNumber = index + 1;
    const commandLikeLine = isCommandLikeLine(line, inFencedCodeBlock);
    const sessionIds = extractSessionIdOccurrences(line)
      .filter((occurrence) => !isInNegationContext(line, occurrence.offset))
      .map((occurrence) => occurrence.id);
    const destroyContextIndex = findFirstMatchIndex(
      line,
      SESSION_DESTROY_CONTEXT_PATTERN,
    );
    const createContextIndex = findFirstMatchIndex(
      line,
      SESSION_CREATE_CONTEXT_PATTERN,
    );
    const isDestroyContext =
      commandLikeLine &&
      destroyContextIndex !== null &&
      !isInNegationContext(line, destroyContextIndex);
    const isCreateContext =
      commandLikeLine &&
      createContextIndex !== null &&
      !isInNegationContext(line, createContextIndex);
    const hasStructuredSessionReference =
      sessionIds.length > 0 &&
      isStructuredSessionReferenceLine(line) &&
      (inFencedCodeBlock || commandLikeLine);

    if (isDestroyContext) {
      markSessionCleanup(records, createdById, pendingCleanupIds, sessionIds);
      continue;
    }

    if (isCreateContext || hasStructuredSessionReference) {
      registerSessionCreation(
        records,
        createdById,
        pendingAnonymousRecords,
        pendingCleanupIds,
        sessionIds,
        lineNumber,
        line.trim() || rule.description,
      );
    }
  }

  reconcileAnonymousSessionCleanup(
    records,
    pendingAnonymousRecords,
    pendingCleanupIds,
  );

  return records
    .filter((record) => !record.cleaned)
    .map((record) => {
      const matchedText =
        record.id === undefined
          ? record.matchedText
          : `${record.matchedText} (session ${record.id})`;
      return buildFinding(
        rule,
        matchedText,
        record.lineNumber,
        'Session creation appears to be orphaned because no matching agent-tty destroy/kill cleanup was found.',
      );
    });
}

function registerSessionCreation(
  records: SessionCreationRecord[],
  createdById: Map<string, number>,
  pendingAnonymousRecords: number[],
  pendingCleanupIds: Set<string>,
  sessionIds: readonly string[],
  lineNumber: number,
  matchedText: string,
): void {
  if (sessionIds.length === 0) {
    records.push({
      lineNumber,
      matchedText,
      cleaned: false,
    });
    pendingAnonymousRecords.push(records.length - 1);
    return;
  }

  for (const sessionId of sessionIds) {
    const existingIndex = createdById.get(sessionId);
    if (existingIndex !== undefined) {
      const existingRecord = records[existingIndex];
      invariant(
        existingRecord !== undefined,
        `missing session record at index ${String(existingIndex)}`,
      );
      if (pendingCleanupIds.delete(sessionId)) {
        existingRecord.cleaned = true;
      }
      continue;
    }

    const anonymousIndex = pendingAnonymousRecords.shift();
    if (anonymousIndex !== undefined) {
      const record = records[anonymousIndex];
      invariant(
        record !== undefined,
        `missing anonymous session record at index ${String(anonymousIndex)}`,
      );
      record.id = sessionId;
      if (pendingCleanupIds.delete(sessionId)) {
        record.cleaned = true;
      }
      createdById.set(sessionId, anonymousIndex);
      continue;
    }

    records.push({
      id: sessionId,
      lineNumber,
      matchedText,
      cleaned: pendingCleanupIds.delete(sessionId),
    });
    createdById.set(sessionId, records.length - 1);
  }
}

function markSessionCleanup(
  records: SessionCreationRecord[],
  createdById: Map<string, number>,
  pendingCleanupIds: Set<string>,
  sessionIds: readonly string[],
): void {
  if (sessionIds.length > 0) {
    for (const sessionId of sessionIds) {
      const recordIndex = createdById.get(sessionId);
      if (recordIndex !== undefined) {
        const record = records[recordIndex];
        invariant(
          record !== undefined,
          `missing session record at index ${String(recordIndex)}`,
        );
        record.cleaned = true;
        continue;
      }

      pendingCleanupIds.add(sessionId);
    }
    return;
  }

  const unmatchedRecord = records.find((record) => !record.cleaned);
  if (unmatchedRecord) {
    unmatchedRecord.cleaned = true;
  }
}

function reconcileAnonymousSessionCleanup(
  records: SessionCreationRecord[],
  pendingAnonymousRecords: readonly number[],
  pendingCleanupIds: Set<string>,
): void {
  if (pendingCleanupIds.size === 0) {
    return;
  }

  for (const anonymousIndex of pendingAnonymousRecords) {
    if (pendingCleanupIds.size === 0) {
      break;
    }

    const record = records[anonymousIndex];
    invariant(
      record !== undefined,
      `missing anonymous session record at index ${String(anonymousIndex)}`,
    );
    if (record.cleaned || record.id !== undefined) {
      continue;
    }

    record.cleaned = true;
    const nextPendingCleanup = pendingCleanupIds.values().next();
    invariant(
      !nextPendingCleanup.done,
      'pending cleanup ids must contain a value',
    );
    pendingCleanupIds.delete(nextPendingCleanup.value);
  }
}

type SessionIdOccurrence = {
  id: string;
  offset: number;
};

function extractSessionIdOccurrences(line: string): SessionIdOccurrence[] {
  const occurrences: SessionIdOccurrence[] = [];
  const seenKeys = new Set<string>();

  for (const pattern of SESSION_ID_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(line);

    while (match !== null) {
      const sessionId = match[1]?.trim();
      invariant(
        typeof match.index === 'number',
        'session-id match index missing',
      );
      if (sessionId) {
        const occurrenceKey = `${sessionId}:${String(match.index)}`;
        if (!seenKeys.has(occurrenceKey)) {
          seenKeys.add(occurrenceKey);
          occurrences.push({
            id: sessionId,
            offset: match.index,
          });
        }
      }

      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }

      match = pattern.exec(line);
    }
  }

  return occurrences;
}

function findFirstMatchIndex(line: string, pattern: RegExp): number | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(line);
  if (match === null) {
    return null;
  }

  invariant(
    typeof match.index === 'number',
    'anti-pattern context index missing',
  );
  return match.index;
}

function isStructuredSessionReferenceLine(line: string): boolean {
  return STRUCTURED_SESSION_REFERENCE_LINE_PATTERN.test(line);
}
