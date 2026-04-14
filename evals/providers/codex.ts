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

const DEFAULT_CODEX_CAPABILITIES: ProviderCapabilities = {
  supportsDetect: true,
  supportsPlanMode: true,
  supportsAgentMode: true,
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsTranscriptCapture: true,
};

const DEFAULT_CODEX_CONFIG: ProviderConfig = {
  providerId: 'codex',
  mode: 'agent-run',
  command: ['codex'],
  defaultModelId: 'o4-mini',
  capabilities: DEFAULT_CODEX_CAPABILITIES,
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

type ParsedCodexOutput = {
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

function resolveTimeoutMs(
  overrideTimeoutMs: number | undefined,
  requestTimeoutMs: number,
): number {
  if (overrideTimeoutMs !== undefined) {
    invariant(
      Number.isInteger(overrideTimeoutMs) && overrideTimeoutMs >= 0,
      'Codex timeout override must be a non-negative integer',
    );
    return overrideTimeoutMs;
  }

  invariant(
    Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0,
    'Codex request timeout must be a positive integer',
  );
  return requestTimeoutMs;
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

function extractTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextFragments(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  const fragments: string[] = [];
  for (const key of [
    'text',
    'content',
    'result',
    'output',
    'message',
    'summary',
    'reasoning',
    'details',
  ] as const) {
    if (value[key] !== undefined) {
      fragments.push(...extractTextFragments(value[key]));
    }
  }

  return fragments;
}

function extractPlainTextToolCalls(
  raw: string,
): Array<Record<string, unknown>> {
  const toolCalls: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:Running|Executed)\s+command\s*:?\s*(.+)$/gmu,
    /(?:^|\n)\s*\$\s+(.+)$/gmu,
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const command = match[1]?.trim();
      if (command === undefined || command.length === 0 || seen.has(command)) {
        continue;
      }
      seen.add(command);
      toolCalls.push({
        type: 'command_execution',
        command,
      });
    }
  }

  return toolCalls;
}

function buildPrompt(prompt: string, context?: string): string {
  assertString(prompt, 'Codex prompt must be a string');
  invariant(prompt.length > 0, 'Codex prompt must be non-empty');
  if (context === undefined || context.length === 0) {
    return prompt;
  }

  assertString(context, 'Codex context must be a string when provided');
  return `${prompt}\n\nAdditional context:\n${context}`;
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<CommandExecutionResult> {
  invariant(command.length > 0, 'Codex command must include an executable');
  const executable = command[0];
  invariant(executable !== undefined, 'Codex executable must be defined');
  assertString(executable, 'Codex executable must be a string');
  invariant(executable.length > 0, 'Codex executable must be non-empty');
  assertStringRecord(env, 'Codex env');
  invariant(
    Number.isInteger(timeoutMs) && timeoutMs >= 0,
    'Codex timeout must be a non-negative integer',
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
          ? new Error(`Codex command timed out after ${String(timeoutMs)}ms`)
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

/** Provider adapter for the Codex CLI. */
export class CodexProvider implements EvalProvider {
  public readonly id = 'codex';

  private readonly config: ProviderConfig;

  /** Creates a Codex provider with optional command, model, and timeout overrides. */
  public constructor(
    config: Omit<Partial<ProviderConfig>, 'capabilities'> & {
      capabilities?: Partial<ProviderCapabilities>;
    } = {},
  ) {
    invariant(
      config.providerId === undefined || config.providerId === this.id,
      'CodexProvider config.providerId must be codex when provided',
    );
    assertStringRecord(config.env, 'Codex provider config env');

    const { capabilities, ...baseConfig } = config;
    this.config = parseProviderConfig(
      {
        ...DEFAULT_CODEX_CONFIG,
        ...baseConfig,
        command: baseConfig.command ?? DEFAULT_CODEX_CONFIG.command,
        capabilities: mergeCapabilities(
          DEFAULT_CODEX_CAPABILITIES,
          capabilities,
        ),
      },
      'Invalid Codex provider config',
    );
  }

  /** Detects whether Codex CLI is installed and returns runtime metadata. */
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
          notes: ['Codex CLI not found on PATH'],
        },
        'Invalid Codex runtime info',
      );
    }

    const combinedOutput = `${execution.stdout}\n${execution.stderr}`.trim();
    const version = extractVersion(combinedOutput);
    const available = execution.exitCode === 0 && !execution.timedOut;
    const notes = available
      ? [
          ...(version === undefined
            ? []
            : [`detected Codex version ${version}`]),
          ...(combinedOutput.length === 0
            ? ['Codex version output was empty']
            : []),
        ]
      : [
          buildErrorMessage(
            execution,
            `Codex detection failed with exit code ${String(execution.exitCode)}`,
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
      'Invalid Codex runtime info',
    );
  }

  /** Runs Codex once in non-interactive exec mode for prompt-only evals. */
  public async invokePlanMode(
    request: ProviderPromptRequest,
  ): Promise<ProviderPromptResult> {
    const parsedRequest = parsePromptRequest(
      request,
      'Invalid Codex plan-mode request',
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
        'Invalid Codex unavailable plan-mode result',
      );
    }

    const timeoutMs = resolveTimeoutMs(
      this.config.timeoutMs,
      parsedRequest.evalCase.budgets.timeoutMs,
    );
    const startedAtMs = Date.now();
    const execution = await runCommand(
      [
        ...this.config.command,
        'exec',
        '--color',
        'never',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--skip-git-repo-check',
        ...(parsedRequest.modelId === undefined
          ? []
          : ['--model', parsedRequest.modelId]),
        buildPrompt(
          parsedRequest.evalCase.prompt,
          parsedRequest.evalCase.context,
        ),
      ],
      resolve(parsedRequest.cwd ?? this.config.cwd ?? process.cwd()),
      {
        ...this.config.env,
        ...parsedRequest.env,
      },
      timeoutMs,
    );
    const completedAtMs = startedAtMs + execution.durationMs;
    const parsedOutput = this.parseCodexOutput(
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
      'Invalid Codex prompt runtime info',
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
                : 'CodexExecutionError',
              errorMessage: buildErrorMessage(
                execution,
                'Codex plan-mode invocation failed',
              ),
            }),
      },
      'Invalid Codex plan-mode result',
    );
  }

  /** Runs Codex in unattended agent mode and captures its JSONL transcript. */
  public async invokeAgentMode(
    request: ProviderAgentRequest,
  ): Promise<ProviderAgentResult> {
    const parsedRequest = parseAgentRequest(
      request,
      'Invalid Codex agent-mode request',
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
        'Invalid Codex unavailable agent-mode result',
      );
    }

    const timeoutMs = resolveTimeoutMs(
      this.config.timeoutMs,
      parsedRequest.evalCase.budgets.timeoutMs,
    );
    const startedAtMs = Date.now();
    const execution = await runCommand(
      [
        ...this.config.command,
        'exec',
        '--json',
        '--color',
        'never',
        '--full-auto',
        '--ask-for-approval',
        'never',
        '--skip-git-repo-check',
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
    const parsedOutput = this.parseCodexOutput(
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
      'Invalid Codex agent runtime info',
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
                : 'CodexExecutionError',
              errorMessage: buildErrorMessage(
                execution,
                'Codex agent-mode invocation failed',
              ),
            }),
      },
      'Invalid Codex agent-mode result',
    );
  }

  /** Normalizes raw Codex CLI output, including JSONL event streams. */
  public parse(raw: string): NormalizedProviderOutput {
    assertString(raw, 'CodexProvider.parse raw input must be a string');
    return this.parseCodexOutput(raw).normalized;
  }

  private parseCodexOutput(raw: string): ParsedCodexOutput {
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
          'Invalid empty Codex normalized output',
        ),
      };
    }

    const parsedJsonl = this.parseCodexJsonLines(raw);
    if (parsedJsonl !== undefined) {
      return parsedJsonl;
    }

    const selectedSkill = inferSelectedSkillFromText(trimmed);
    return {
      normalized: coerceNormalizedOutput(
        {
          finalText: trimmed,
          messages: [trimmed],
          referencedSkills: extractReferencedSkills([trimmed]),
          ...(selectedSkill === undefined ? {} : { selectedSkill }),
          toolCalls: extractPlainTextToolCalls(raw),
        },
        raw,
        'Invalid Codex text normalized output',
      ),
    };
  }

  private parseCodexJsonLines(raw: string): ParsedCodexOutput | undefined {
    const nonEmptyLines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (nonEmptyLines.length === 0) {
      return undefined;
    }

    const records: unknown[] = [];
    for (const line of nonEmptyLines) {
      const parsedLine = tryParseJson(line);
      if (parsedLine === undefined) {
        return undefined;
      }
      records.push(parsedLine);
    }

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

      if (
        record.type === 'thread.started' &&
        typeof record.thread_id === 'string'
      ) {
        sessionId = record.thread_id;
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

      if (record.type === 'error') {
        const errorText = extractTextFragments(record).join('\n').trim();
        if (errorText.length > 0) {
          messages.push(`error: ${errorText}`);
          if (finalText.length === 0) {
            finalText = errorText;
          }
        }
      }

      const item = isRecord(record.item) ? record.item : undefined;
      if (item === undefined) {
        return;
      }

      const itemType = typeof item.type === 'string' ? item.type : undefined;
      const itemText = extractTextFragments(item).join('\n').trim();
      if (typeof item.model === 'string') {
        modelId = item.model;
      }
      if (selectedSkill === undefined && itemText.length > 0) {
        selectedSkill = inferSelectedSkillFromText(itemText);
      }

      if (itemType === 'agent_message') {
        if (itemText.length > 0) {
          messages.push(`assistant: ${itemText}`);
          finalText = itemText;
        }
        return;
      }

      if (itemType === 'reasoning') {
        if (itemText.length > 0) {
          reasoningFragments.push(itemText);
          messages.push(`reasoning: ${itemText}`);
        }
        return;
      }

      const itemId =
        typeof item.id === 'string'
          ? item.id
          : `${String(index)}:${itemType ?? 'item'}`;
      const existing = toolCalls.get(itemId);
      toolCalls.set(itemId, {
        ...existing,
        eventType: record.type,
        ...item,
      });
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
        'Invalid Codex JSONL normalized output',
      ),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(modelId === undefined ? {} : { modelId }),
    };
  }
}

function trimmedOrRaw(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : raw;
}
