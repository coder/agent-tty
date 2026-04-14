import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

import { assertString, invariant } from '../../src/util/assert.js';
import {
  NormalizedProviderOutputSchema,
  ProviderAgentRequestSchema,
  ProviderAgentResultSchema,
  ProviderConfigSchema,
  ProviderPromptRequestSchema,
  ProviderPromptResultSchema,
  ProviderRuntimeInfoSchema,
} from '../lib/schemas.js';
import type {
  NormalizedProviderOutput,
  ProviderAgentRequest,
  ProviderAgentResult,
  ProviderCapabilities,
  ProviderConfig,
  ProviderPromptRequest,
  ProviderPromptResult,
  ProviderRuntimeInfo,
} from '../lib/types.js';
import type { EvalProvider } from './base.js';

const DEFAULT_DETECT_TIMEOUT_MS = 10_000;
const ROLE_PREFIX_PATTERN = /^(human|user|assistant|claude|system)$/u;

const DEFAULT_CLAUDE_CAPABILITIES: ProviderCapabilities = {
  supportsDetect: true,
  supportsPlanMode: true,
  supportsAgentMode: true,
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsTranscriptCapture: true,
};

const DEFAULT_CLAUDE_CONFIG: ProviderConfig = {
  providerId: 'claude',
  mode: 'agent-run',
  command: ['claude'],
  defaultModelId: 'sonnet',
  capabilities: DEFAULT_CLAUDE_CAPABILITIES,
};

type CommandExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  error?: Error;
};

type ParsedClaudeOutput = {
  normalized: NormalizedProviderOutput;
  sessionId?: string;
  modelId?: string;
};

function failInvariant(message: string): never {
  invariant(false, message);
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringRecord(
  value: Record<string, string> | undefined,
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  invariant(!Array.isArray(value), `${label} must be a record of strings`);

  for (const [key, entryValue] of Object.entries(value)) {
    assertString(key, `${label} keys must be strings`);
    invariant(key.length > 0, `${label} keys must be non-empty strings`);
    assertString(entryValue, `${label}.${key} must be a string`);
  }
}

function mergeCapabilities(
  defaults: ProviderCapabilities,
  overrides?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  return {
    ...defaults,
    ...overrides,
  };
}

function parseProviderConfig(config: unknown, message: string): ProviderConfig {
  const parsedResult = ProviderConfigSchema.safeParse(config);
  if (parsedResult.success) {
    return parsedResult.data as ProviderConfig;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function parseRuntimeInfo(
  runtimeInfo: unknown,
  message: string,
): ProviderRuntimeInfo {
  const parsedResult = ProviderRuntimeInfoSchema.safeParse(runtimeInfo);
  if (parsedResult.success) {
    return parsedResult.data as ProviderRuntimeInfo;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function parsePromptRequest(
  request: unknown,
  message: string,
): ProviderPromptRequest {
  const parsedResult = ProviderPromptRequestSchema.safeParse(request);
  if (parsedResult.success) {
    return parsedResult.data as ProviderPromptRequest;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function parsePromptResult(
  result: unknown,
  message: string,
): ProviderPromptResult {
  const parsedResult = ProviderPromptResultSchema.safeParse(result);
  if (parsedResult.success) {
    return parsedResult.data as ProviderPromptResult;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function parseAgentRequest(
  request: unknown,
  message: string,
): ProviderAgentRequest {
  const parsedResult = ProviderAgentRequestSchema.safeParse(request);
  if (parsedResult.success) {
    return parsedResult.data as ProviderAgentRequest;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function parseAgentResult(
  result: unknown,
  message: string,
): ProviderAgentResult {
  const parsedResult = ProviderAgentResultSchema.safeParse(result);
  if (parsedResult.success) {
    return parsedResult.data as ProviderAgentResult;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function coerceNormalizedOutput(
  candidate: unknown,
  raw: string,
  message: string,
): NormalizedProviderOutput {
  const parsedResult = NormalizedProviderOutputSchema.safeParse(candidate);
  if (parsedResult.success) {
    return parsedResult.data as NormalizedProviderOutput;
  }

  const fallback = NormalizedProviderOutputSchema.safeParse({
    finalText: raw,
    messages: raw.length > 0 ? [raw] : [],
    referencedSkills: [],
    toolCalls: [],
  });
  if (fallback.success) {
    return fallback.data as NormalizedProviderOutput;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
}

function buildPrompt(prompt: string, context?: string): string {
  assertString(prompt, 'Claude prompt must be a string');
  invariant(prompt.length > 0, 'Claude prompt must be non-empty');
  if (context === undefined || context.length === 0) {
    return prompt;
  }

  assertString(context, 'Claude context must be a string when provided');
  return `${prompt}\n\nAdditional context:\n${context}`;
}

function resolveTimeoutMs(
  overrideTimeoutMs: number | undefined,
  requestTimeoutMs: number,
): number {
  if (overrideTimeoutMs !== undefined) {
    invariant(
      Number.isInteger(overrideTimeoutMs) && overrideTimeoutMs >= 0,
      'Claude timeout override must be a non-negative integer',
    );
    return overrideTimeoutMs;
  }

  invariant(
    Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0,
    'Claude request timeout must be a positive integer',
  );
  return requestTimeoutMs;
}

function extractMaxAgentSteps(
  request: ProviderAgentRequest,
): number | undefined {
  const budgets = request.evalCase.budgets;
  return 'maxAgentSteps' in budgets ? budgets.maxAgentSteps : undefined;
}

function extractVersion(rawOutput: string): string | undefined {
  const trimmed = rawOutput.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const semanticVersionMatch = trimmed.match(
    /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u,
  );
  if (semanticVersionMatch !== null) {
    return semanticVersionMatch[0];
  }

  const firstToken = trimmed.split(/\s+/u)[0] ?? '';
  return firstToken.length > 0 ? firstToken : undefined;
}

function extractReferencedSkills(texts: readonly string[]): string[] {
  const joinedText = texts.join('\n').toLowerCase();
  const referencedSkills: string[] = [];

  for (const skill of ['agent-tty', 'dogfood-tui'] as const) {
    if (joinedText.includes(skill)) {
      referencedSkills.push(skill);
    }
  }

  return referencedSkills;
}

function inferSelectedSkill(
  ...candidates: Array<string | undefined>
): 'none' | 'agent-tty' | 'dogfood-tui' | undefined {
  for (const candidate of candidates) {
    if (
      candidate === 'none' ||
      candidate === 'agent-tty' ||
      candidate === 'dogfood-tui'
    ) {
      return candidate;
    }
  }

  return undefined;
}

function inferSelectedSkillFromText(
  text: string,
): 'none' | 'agent-tty' | 'dogfood-tui' | undefined {
  const explicitMatch = text.match(
    /selected\s+skill\s*[:=-]\s*(none|agent-tty|dogfood-tui)/iu,
  );
  return inferSelectedSkill(explicitMatch?.[1]?.toLowerCase());
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseJsonRecords(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const wholeValue = tryParseJson(trimmed);
  if (wholeValue !== undefined) {
    return Array.isArray(wholeValue) ? wholeValue : [wholeValue];
  }

  const records: unknown[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('{') && !trimmedLine.startsWith('[')) {
      continue;
    }

    const parsedLine = tryParseJson(trimmedLine);
    if (parsedLine !== undefined) {
      records.push(parsedLine);
    }
  }

  return records;
}

function extractPlainTextToolCalls(
  raw: string,
): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:Tool(?:\s+use)?|Using tool)\s*:?\s*([A-Za-z][A-Za-z0-9_-]+)(?:\(([^)]*)\))?/gmu,
    /(?:^|\n)\s*([A-Z][A-Za-z0-9_-]{2,})\(([^)]*)\)\s*$/gmu,
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (
        name === undefined ||
        name.length === 0 ||
        ROLE_PREFIX_PATTERN.test(name.toLowerCase())
      ) {
        continue;
      }

      const key = `${name}:${match[2] ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      toolCalls.push({
        name,
        ...(match[2] === undefined ? {} : { input: match[2].trim() }),
      });
    }
  }

  return toolCalls;
}

function extractPlainTextMessages(raw: string): {
  messages: string[];
  finalText: string;
} {
  const pattern = /(?:^|\n)(Human|User|Assistant|Claude|System)\s*:\s*/gmu;
  const sections: Array<{ role?: string; content: string }> = [];
  let lastMatch = pattern.exec(raw);

  if (lastMatch === null) {
    const trimmed = raw.trim();
    return {
      messages: trimmed.length > 0 ? [trimmed] : [],
      finalText: trimmed,
    };
  }

  if (lastMatch.index > 0) {
    const preamble = raw.slice(0, lastMatch.index).trim();
    if (preamble.length > 0) {
      sections.push({ content: preamble });
    }
  }

  while (lastMatch !== null) {
    const matchedRole = lastMatch[1];
    invariant(
      matchedRole !== undefined,
      'Claude plain-text role match must include a role name',
    );
    const role = matchedRole.toLowerCase();
    const contentStart = pattern.lastIndex;
    const nextMatch = pattern.exec(raw);
    const contentEnd = nextMatch?.index ?? raw.length;
    const content = raw.slice(contentStart, contentEnd).trim();
    if (content.length > 0) {
      sections.push({ role, content });
    }
    lastMatch = nextMatch;
  }

  const messages = sections.map((section) =>
    section.role === undefined
      ? section.content
      : `${section.role}: ${section.content}`,
  );
  const finalAssistantSection = [...sections]
    .reverse()
    .find(
      (section) => section.role === 'assistant' || section.role === 'claude',
    );
  const lastSection = sections[sections.length - 1];

  return {
    messages,
    finalText: finalAssistantSection?.content ?? lastSection?.content ?? '',
  };
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<CommandExecutionResult> {
  invariant(command.length > 0, 'Claude command must include an executable');
  const executable = command[0];
  invariant(executable !== undefined, 'Claude executable must be defined');
  assertString(executable, 'Claude executable must be a string');
  invariant(executable.length > 0, 'Claude executable must be non-empty');
  assertStringRecord(env, 'Claude env');
  invariant(
    Number.isInteger(timeoutMs) && timeoutMs >= 0,
    'Claude timeout must be a non-negative integer',
  );

  const startedAtMs = Date.now();
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;

  return await new Promise((resolveResult) => {
    let settled = false;
    const settle = (
      result: Omit<CommandExecutionResult, 'durationMs'>,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      resolveResult({
        ...result,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
    };

    const child = execFile(
      executable,
      [...command.slice(1)],
      {
        cwd,
        env: {
          ...process.env,
          ...env,
        },
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        signal: controller.signal,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const exitCode =
          error === null
            ? (child.exitCode ?? 0)
            : typeof error.code === 'number'
              ? error.code
              : child.exitCode;
        const signal = error?.signal ?? child.signalCode;
        const resolvedError = timedOut
          ? new Error(`Claude command timed out after ${String(timeoutMs)}ms`)
          : (error ?? undefined);
        settle({
          stdout,
          stderr,
          exitCode,
          signal,
          timedOut,
          ...(resolvedError === undefined ? {} : { error: resolvedError }),
        });
      },
    );

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
        }, 1_000).unref();
      }, timeoutMs);
    }
  });
}

function isCommandNotFoundError(error: Error | undefined): boolean {
  const errnoError = error as NodeJS.ErrnoException | undefined;
  return errnoError?.code === 'ENOENT';
}

function buildErrorMessage(
  execution: CommandExecutionResult,
  fallbackMessage: string,
): string {
  const stderr = execution.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  if (execution.error !== undefined && execution.error.message.length > 0) {
    return execution.error.message;
  }
  return fallbackMessage;
}

/** Provider adapter for the Claude Code CLI. */
export class ClaudeProvider implements EvalProvider {
  public readonly id = 'claude';

  private readonly config: ProviderConfig;

  /** Creates a Claude Code provider with optional command, model, and timeout overrides. */
  public constructor(
    config: Omit<Partial<ProviderConfig>, 'capabilities'> & {
      capabilities?: Partial<ProviderCapabilities>;
    } = {},
  ) {
    invariant(
      config.providerId === undefined || config.providerId === this.id,
      'ClaudeProvider config.providerId must be claude when provided',
    );
    assertStringRecord(config.env, 'Claude provider config env');

    const { capabilities, ...baseConfig } = config;
    this.config = parseProviderConfig(
      {
        ...DEFAULT_CLAUDE_CONFIG,
        ...baseConfig,
        command: baseConfig.command ?? DEFAULT_CLAUDE_CONFIG.command,
        capabilities: mergeCapabilities(
          DEFAULT_CLAUDE_CAPABILITIES,
          capabilities,
        ),
      },
      'Invalid Claude provider config',
    );
  }

  /** Detects whether the Claude CLI is installed and returns its runtime metadata. */
  public async detect(): Promise<ProviderRuntimeInfo> {
    const cwd = resolve(this.config.cwd ?? process.cwd());
    const execution = await runCommand(
      [...this.config.command, '--version'],
      cwd,
      this.config.env,
      this.config.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS,
    );
    const detectedAt = new Date().toISOString();
    const defaultModelId = this.config.defaultModelId;

    if (isCommandNotFoundError(execution.error)) {
      return parseRuntimeInfo(
        {
          providerId: this.id,
          available: false,
          detectedAt,
          commandPath: this.config.command[0],
          ...(defaultModelId === undefined ? {} : { defaultModelId }),
          capabilities: this.config.capabilities,
          notes: ['Claude CLI not found on PATH'],
        },
        'Invalid Claude runtime info',
      );
    }

    const combinedOutput = `${execution.stdout}\n${execution.stderr}`.trim();
    const version = extractVersion(combinedOutput);
    const available = execution.exitCode === 0 && !execution.timedOut;
    const notes = available
      ? [
          ...(version === undefined
            ? []
            : [`detected Claude version ${version}`]),
          ...(combinedOutput.length === 0
            ? ['Claude version output was empty']
            : []),
        ]
      : [
          buildErrorMessage(
            execution,
            `Claude detection failed with exit code ${String(execution.exitCode)}`,
          ),
        ];

    return parseRuntimeInfo(
      {
        providerId: this.id,
        available,
        detectedAt,
        ...(version === undefined ? {} : { version }),
        commandPath: this.config.command[0],
        ...(defaultModelId === undefined ? {} : { defaultModelId }),
        capabilities: this.config.capabilities,
        notes,
      },
      'Invalid Claude runtime info',
    );
  }

  /** Runs Claude in print mode for a single prompt-only eval case. */
  public async invokePlanMode(
    request: ProviderPromptRequest,
  ): Promise<ProviderPromptResult> {
    const parsedRequest = parsePromptRequest(
      request,
      'Invalid Claude plan-mode request',
    );
    const runtime = await this.detect();
    if (!runtime.available) {
      return parsePromptResult(
        {
          request: parsedRequest,
          runtime,
          ok: false,
          exitCode: null,
          signal: null,
          startedAt: runtime.detectedAt,
          completedAt: runtime.detectedAt,
          durationMs: 0,
          rawStdout: '',
          rawStderr: runtime.notes.join('\n'),
          normalized: this.parse(runtime.notes.join('\n')),
          errorClass: 'ProviderUnavailable',
          errorMessage: runtime.notes.join('\n'),
        },
        'Invalid Claude unavailable plan-mode result',
      );
    }

    const prompt = buildPrompt(
      parsedRequest.evalCase.prompt,
      parsedRequest.evalCase.context,
    );
    const timeoutMs = resolveTimeoutMs(
      this.config.timeoutMs,
      parsedRequest.evalCase.budgets.timeoutMs,
    );
    const startedAtMs = Date.now();
    const execution = await runCommand(
      [
        ...this.config.command,
        '--print',
        '--output-format',
        'json',
        ...(parsedRequest.modelId === undefined
          ? []
          : ['--model', parsedRequest.modelId]),
        prompt,
      ],
      resolve(parsedRequest.cwd ?? this.config.cwd ?? process.cwd()),
      {
        ...this.config.env,
        ...parsedRequest.env,
      },
      timeoutMs,
    );
    const completedAtMs = startedAtMs + execution.durationMs;
    const parsedOutput = this.parseClaudeOutput(
      execution.stdout.length > 0 ? execution.stdout : execution.stderr,
    );
    const runtimeWithModel = parseRuntimeInfo(
      {
        ...runtime,
        defaultModelId:
          parsedOutput.modelId ??
          parsedRequest.modelId ??
          runtime.defaultModelId,
      },
      'Invalid Claude prompt runtime info',
    );
    const ok = execution.exitCode === 0 && !execution.timedOut;

    return parsePromptResult(
      {
        request: parsedRequest,
        runtime: runtimeWithModel,
        ok,
        exitCode: execution.exitCode,
        signal: execution.signal,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: execution.durationMs,
        rawStdout: execution.stdout,
        rawStderr: execution.stderr,
        normalized: parsedOutput.normalized,
        ...(ok
          ? {}
          : {
              errorClass: execution.timedOut
                ? 'TimeoutError'
                : 'ClaudeExecutionError',
              errorMessage: buildErrorMessage(
                execution,
                'Claude plan-mode invocation failed',
              ),
            }),
      },
      'Invalid Claude plan-mode result',
    );
  }

  /** Runs Claude in headless agent mode and captures the full transcript. */
  public async invokeAgentMode(
    request: ProviderAgentRequest,
  ): Promise<ProviderAgentResult> {
    const parsedRequest = parseAgentRequest(
      request,
      'Invalid Claude agent-mode request',
    );
    const runtime = await this.detect();
    if (!runtime.available) {
      return parseAgentResult(
        {
          request: parsedRequest,
          runtime,
          ok: false,
          exitCode: null,
          signal: null,
          startedAt: runtime.detectedAt,
          completedAt: runtime.detectedAt,
          durationMs: 0,
          rawStdout: '',
          rawStderr: runtime.notes.join('\n'),
          normalized: this.parse(runtime.notes.join('\n')),
          errorClass: 'ProviderUnavailable',
          errorMessage: runtime.notes.join('\n'),
        },
        'Invalid Claude unavailable agent-mode result',
      );
    }

    const timeoutMs = resolveTimeoutMs(
      this.config.timeoutMs,
      parsedRequest.evalCase.budgets.timeoutMs,
    );
    const maxAgentSteps = extractMaxAgentSteps(parsedRequest);
    const startedAtMs = Date.now();
    const execution = await runCommand(
      [
        ...this.config.command,
        '--print',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        ...(maxAgentSteps === undefined
          ? []
          : ['--max-turns', String(maxAgentSteps)]),
        ...(parsedRequest.modelId === undefined
          ? []
          : ['--model', parsedRequest.modelId]),
        parsedRequest.evalCase.prompt,
      ],
      resolve(parsedRequest.cwd),
      {
        ...this.config.env,
        ...parsedRequest.env,
      },
      timeoutMs,
    );
    const completedAtMs = startedAtMs + execution.durationMs;
    const parsedOutput = this.parseClaudeOutput(
      execution.stdout.length > 0 ? execution.stdout : execution.stderr,
    );
    const runtimeWithModel = parseRuntimeInfo(
      {
        ...runtime,
        defaultModelId:
          parsedOutput.modelId ??
          parsedRequest.modelId ??
          runtime.defaultModelId,
      },
      'Invalid Claude agent runtime info',
    );
    const ok = execution.exitCode === 0 && !execution.timedOut;

    return parseAgentResult(
      {
        request: parsedRequest,
        runtime: runtimeWithModel,
        ok,
        exitCode: execution.exitCode,
        signal: execution.signal,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: execution.durationMs,
        rawStdout: execution.stdout,
        rawStderr: execution.stderr,
        normalized: parsedOutput.normalized,
        ...(parsedOutput.sessionId === undefined
          ? {}
          : { sessionId: parsedOutput.sessionId }),
        ...(ok
          ? {}
          : {
              errorClass: execution.timedOut
                ? 'TimeoutError'
                : 'ClaudeExecutionError',
              errorMessage: buildErrorMessage(
                execution,
                'Claude agent-mode invocation failed',
              ),
            }),
      },
      'Invalid Claude agent-mode result',
    );
  }

  /** Normalizes raw Claude CLI output into eval-friendly fields. */
  public parse(raw: string): NormalizedProviderOutput {
    assertString(raw, 'ClaudeProvider.parse raw input must be a string');
    return this.parseClaudeOutput(raw).normalized;
  }

  private parseClaudeOutput(raw: string): ParsedClaudeOutput {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {
        normalized: coerceNormalizedOutput(
          {
            finalText: '',
            messages: [],
            referencedSkills: [],
            toolCalls: [],
          },
          '',
          'Invalid empty Claude normalized output',
        ),
      };
    }

    const jsonRecords = parseJsonRecords(raw);
    if (jsonRecords.length > 0) {
      return this.parseClaudeJsonRecords(raw, jsonRecords);
    }

    return this.parseClaudePlainText(raw);
  }

  private parseClaudeJsonRecords(
    raw: string,
    records: readonly unknown[],
  ): ParsedClaudeOutput {
    const messages: string[] = [];
    const reasoningFragments: string[] = [];
    const toolCalls = new Map<string, Record<string, unknown>>();
    let finalText = '';
    let sessionId: string | undefined;
    let modelId: string | undefined;
    let selectedSkill: 'none' | 'agent-tty' | 'dogfood-tui' | undefined;

    records.forEach((record, index) => {
      if (!isRecord(record)) {
        return;
      }

      if (typeof record.session_id === 'string' && sessionId === undefined) {
        sessionId = record.session_id;
      }
      if (typeof record.model === 'string' && modelId === undefined) {
        modelId = record.model;
      }
      if (selectedSkill === undefined) {
        selectedSkill = inferSelectedSkill(
          typeof record.selectedSkill === 'string'
            ? record.selectedSkill
            : undefined,
          typeof record.selected_skill === 'string'
            ? record.selected_skill
            : undefined,
        );
      }
      if (record.type === 'result' && typeof record.result === 'string') {
        finalText = record.result;
      }

      const payload = isRecord(record.message) ? record.message : record;
      if (
        isRecord(record.message) &&
        typeof record.message.model === 'string'
      ) {
        modelId = record.message.model;
      }
      const role =
        typeof payload.role === 'string'
          ? payload.role
          : typeof record.type === 'string'
            ? record.type
            : undefined;
      const extracted = this.extractClaudeContent(
        payload.content === undefined ? payload : payload.content,
      );

      for (const reasoningFragment of extracted.reasoning) {
        reasoningFragments.push(reasoningFragment);
      }

      extracted.toolCalls.forEach((toolCall, toolCallIndex) => {
        const fallbackToolName =
          typeof toolCall.name === 'string' ? toolCall.name : 'tool';
        const toolCallId =
          typeof toolCall.id === 'string'
            ? toolCall.id
            : `${String(index)}:${String(toolCallIndex)}:${fallbackToolName}`;
        const existingToolCall = toolCalls.get(toolCallId);
        toolCalls.set(toolCallId, {
          ...existingToolCall,
          ...toolCall,
        });
      });

      const combinedText = extracted.text.join('\n').trim();
      if (combinedText.length > 0) {
        messages.push(
          role === undefined ? combinedText : `${role}: ${combinedText}`,
        );
        if (role === 'assistant' || role === 'claude') {
          finalText = combinedText;
        }
        if (selectedSkill === undefined) {
          selectedSkill = inferSelectedSkillFromText(combinedText);
        }
      }
    });

    const allText = finalText.length > 0 ? [...messages, finalText] : messages;
    return {
      normalized: coerceNormalizedOutput(
        {
          finalText: finalText.length > 0 ? finalText : trimmedOrRaw(raw),
          ...(reasoningFragments.length === 0
            ? {}
            : { reasoningText: reasoningFragments.join('\n\n') }),
          messages,
          referencedSkills: extractReferencedSkills(allText),
          ...(selectedSkill === undefined ? {} : { selectedSkill }),
          toolCalls: [...toolCalls.values()],
        },
        raw,
        'Invalid Claude JSON normalized output',
      ),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(modelId === undefined ? {} : { modelId }),
    };
  }

  private parseClaudePlainText(raw: string): ParsedClaudeOutput {
    const plainText = extractPlainTextMessages(raw);
    const selectedSkill = inferSelectedSkillFromText(
      `${plainText.finalText}\n${plainText.messages.join('\n')}`,
    );

    return {
      normalized: coerceNormalizedOutput(
        {
          finalText: plainText.finalText,
          messages: plainText.messages,
          referencedSkills: extractReferencedSkills([
            plainText.finalText,
            ...plainText.messages,
          ]),
          ...(selectedSkill === undefined ? {} : { selectedSkill }),
          toolCalls: extractPlainTextToolCalls(raw),
        },
        raw,
        'Invalid Claude text normalized output',
      ),
    };
  }

  private extractClaudeContent(content: unknown): {
    text: string[];
    reasoning: string[];
    toolCalls: Array<Record<string, unknown>>;
  } {
    const text: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.trim().length > 0) {
          text.push(value);
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((entry) => {
          visit(entry);
        });
        return;
      }

      if (!isRecord(value)) {
        return;
      }

      const type = typeof value.type === 'string' ? value.type : undefined;
      if (type === 'tool_use' || type === 'tool_result') {
        toolCalls.push({ ...value });
      }

      if (typeof value.text === 'string' && value.text.trim().length > 0) {
        if (type === 'thinking' || type === 'reasoning') {
          reasoning.push(value.text);
        } else {
          text.push(value.text);
        }
      }

      if (typeof value.result === 'string' && value.result.trim().length > 0) {
        text.push(value.result);
      }

      if (
        typeof value.content === 'string' &&
        value.content.trim().length > 0
      ) {
        if (type === 'thinking' || type === 'reasoning') {
          reasoning.push(value.content);
        } else {
          text.push(value.content);
        }
      }

      if (Array.isArray(value.content)) {
        visit(value.content);
      }
      if (value.message !== undefined) {
        visit(value.message);
      }
      if (value.data !== undefined) {
        visit(value.data);
      }
    };

    visit(content);
    return {
      text,
      reasoning,
      toolCalls,
    };
  }
}

function trimmedOrRaw(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : raw;
}
