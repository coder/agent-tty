import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertString, invariant } from '../../src/util/assert.js';
import {
  NormalizedProviderOutputSchema,
  ProviderAgentRequestSchema,
  ProviderAgentResultSchema,
  ProviderCapabilitiesSchema,
  ProviderConfigSchema,
  ProviderPromptRequestSchema,
  ProviderPromptResultSchema,
  ProviderRuntimeInfoSchema,
  TokenUsageSchema,
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
  TokenUsage,
} from '../lib/types.js';
import type { EvalProvider } from './base.js';

const DEFAULT_STUB_CAPABILITIES: ProviderCapabilities = {
  supportsDetect: true,
  supportsPlanMode: true,
  supportsAgentMode: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsTranscriptCapture: true,
};

const DEFAULT_FIXTURE_CAPABILITIES: ProviderCapabilities = {
  supportsDetect: true,
  supportsPlanMode: true,
  supportsAgentMode: true,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsTranscriptCapture: true,
};

const DEFAULT_STUB_CONFIG: ProviderConfig = {
  providerId: 'stub',
  mode: 'stub',
  command: ['stub'],
  defaultModelId: 'stub',
  capabilities: DEFAULT_STUB_CAPABILITIES,
};

const DEFAULT_FIXTURE_CONFIG: ProviderConfig = {
  providerId: 'fixture',
  mode: 'stub',
  command: ['fixture'],
  defaultModelId: 'fixture',
  capabilities: DEFAULT_FIXTURE_CAPABILITIES,
};

function failInvariant(message: string): never {
  invariant(false, message);
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildPassThroughNormalizedOutput(
  raw: string,
  tokenUsage?: TokenUsage,
): NormalizedProviderOutput {
  const parsedResult = NormalizedProviderOutputSchema.safeParse({
    finalText: raw,
    messages: [raw],
    referencedSkills: [],
    toolCalls: [],
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  });

  if (parsedResult.success) {
    return parsedResult.data as NormalizedProviderOutput;
  }

  return failInvariant(
    `Failed to build normalized provider output: ${parsedResult.error.message}`,
  );
}

function coerceOptionalTokenUsage(rawTokenUsage: unknown): TokenUsage | undefined {
  if (rawTokenUsage === undefined) {
    return undefined;
  }

  const parsedTokenUsage = TokenUsageSchema.safeParse(rawTokenUsage);
  if (!parsedTokenUsage.success) {
    return undefined;
  }

  return parsedTokenUsage.data as TokenUsage;
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

function parseNormalizedOutput(
  output: unknown,
  message: string,
): NormalizedProviderOutput {
  const parsedResult = NormalizedProviderOutputSchema.safeParse(output);
  if (parsedResult.success) {
    return parsedResult.data as NormalizedProviderOutput;
  }

  return failInvariant(`${message}: ${parsedResult.error.message}`);
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

function extractCaseId(
  request: ProviderPromptRequest | ProviderAgentRequest,
): string {
  const requestRecord = request as unknown as Record<string, unknown>;
  const directCaseId = requestRecord.caseId;
  if (typeof directCaseId === 'string' && directCaseId.length > 0) {
    return directCaseId;
  }

  const evalCase = requestRecord.evalCase;
  invariant(
    isRecord(evalCase),
    'provider request must include evalCase when caseId is absent',
  );
  const evalCaseId = evalCase.id;
  assertString(evalCaseId, 'provider request evalCase.id must be a string');
  invariant(
    evalCaseId.length > 0,
    'provider request evalCase.id must not be empty',
  );
  return evalCaseId;
}

function resolveStubOutput(
  cannedOutputs: ProviderConfig['cannedOutputs'],
  caseId: string,
  fallbackText: string,
): NormalizedProviderOutput {
  const caseOutput = cannedOutputs?.[caseId];
  if (caseOutput !== undefined) {
    return caseOutput;
  }

  const defaultOutput = cannedOutputs?.default;
  if (defaultOutput !== undefined) {
    return defaultOutput;
  }

  return buildPassThroughNormalizedOutput(fallbackText);
}

function extractStubCannedOutputs(
  cannedOutputs:
    | (Record<string, NormalizedProviderOutput> & { __error?: string })
    | undefined,
): {
  failureMessage: string | undefined;
  normalizedOutputs: ProviderConfig['cannedOutputs'];
} {
  if (cannedOutputs === undefined) {
    return {
      failureMessage: undefined,
      normalizedOutputs: undefined,
    };
  }

  const { __error, ...normalizedOutputs } = cannedOutputs;
  if (__error !== undefined) {
    assertString(
      __error,
      'stub provider cannedOutputs.__error must be a string',
    );
    invariant(
      __error.length > 0,
      'stub provider cannedOutputs.__error must not be empty',
    );
  }

  return {
    failureMessage: __error,
    normalizedOutputs:
      Object.keys(normalizedOutputs).length > 0 ? normalizedOutputs : undefined,
  };
}

/** Stub eval provider for smoke tests and deterministic local runs. */
export class StubProvider implements EvalProvider {
  public readonly id = 'stub';

  private readonly config: ProviderConfig;
  private readonly failureMessage: string | undefined;

  /** Creates a stub provider with optional canned outputs and capability overrides. */
  public constructor(
    config: Omit<Partial<ProviderConfig>, 'capabilities' | 'cannedOutputs'> & {
      capabilities?: Partial<ProviderCapabilities>;
      cannedOutputs?: Record<string, NormalizedProviderOutput> & {
        __error?: string;
      };
    } = {},
  ) {
    invariant(
      config.providerId === undefined || config.providerId === this.id,
      'StubProvider config.providerId must be stub when provided',
    );

    const { cannedOutputs, capabilities, ...baseConfig } = config;
    const extractedOutputs = extractStubCannedOutputs(cannedOutputs);
    this.config = parseProviderConfig(
      {
        ...DEFAULT_STUB_CONFIG,
        ...baseConfig,
        command: baseConfig.command ?? DEFAULT_STUB_CONFIG.command,
        capabilities: mergeCapabilities(
          DEFAULT_STUB_CAPABILITIES,
          capabilities,
        ),
        ...(extractedOutputs.normalizedOutputs === undefined
          ? {}
          : { cannedOutputs: extractedOutputs.normalizedOutputs }),
      },
      'Invalid stub provider config',
    );
    this.failureMessage = extractedOutputs.failureMessage;
  }

  /** Returns fixed runtime information for the stub provider. */
  public detect(): Promise<ProviderRuntimeInfo> {
    this.maybeThrowInjectedError();
    return Promise.resolve(
      parseRuntimeInfo(
        {
          providerId: this.id,
          available: true,
          detectedAt: new Date().toISOString(),
          version: 'stub',
          commandPath: this.config.command[0],
          defaultModelId: this.config.defaultModelId ?? 'stub',
          capabilities: this.config.capabilities,
          notes: ['stub provider available'],
        },
        'Invalid stub provider runtime info',
      ),
    );
  }

  /** Returns a canned plan-mode response for the provided request. */
  public async invokePlanMode(
    request: ProviderPromptRequest,
  ): Promise<ProviderPromptResult> {
    this.maybeThrowInjectedError();

    const parsedRequest = parsePromptRequest(
      request,
      'Invalid stub provider plan-mode request',
    );

    const caseId = extractCaseId(parsedRequest);
    const normalized = resolveStubOutput(
      this.config.cannedOutputs,
      caseId,
      'stub response',
    );
    const timestamp = new Date().toISOString();
    const runtime = await this.detect();

    return parsePromptResult(
      {
        request: parsedRequest,
        runtime,
        ok: true,
        exitCode: 0,
        signal: null,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
        rawStdout: normalized.finalText,
        rawStderr: '',
        normalized,
      },
      'Invalid stub provider plan-mode result',
    );
  }

  /** Returns a canned agent-mode response for the provided request. */
  public async invokeAgentMode(
    request: ProviderAgentRequest,
  ): Promise<ProviderAgentResult> {
    this.maybeThrowInjectedError();

    const parsedRequest = parseAgentRequest(
      request,
      'Invalid stub provider agent-mode request',
    );

    const caseId = extractCaseId(parsedRequest);
    const normalized = resolveStubOutput(
      this.config.cannedOutputs,
      caseId,
      'stub transcript',
    );
    const timestamp = new Date().toISOString();
    const runtime = await this.detect();

    return parseAgentResult(
      {
        request: parsedRequest,
        runtime,
        ok: true,
        exitCode: 0,
        signal: null,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
        rawStdout: normalized.finalText,
        rawStderr: '',
        normalized,
      },
      'Invalid stub provider agent-mode result',
    );
  }

  /** Normalizes raw provider text with a pass-through representation. */
  public parse(raw: string): NormalizedProviderOutput {
    this.maybeThrowInjectedError();
    assertString(raw, 'StubProvider.parse raw input must be a string');
    return buildPassThroughNormalizedOutput(raw);
  }

  private maybeThrowInjectedError(): void {
    if (this.failureMessage !== undefined) {
      throw new Error(this.failureMessage);
    }
  }
}

/** Recording decorator that captures every provider request and response. */
export class RecordingProvider implements EvalProvider {
  public readonly id = 'recording';

  private readonly inner: EvalProvider;
  private readonly recordings: Array<{
    method: string;
    request: unknown;
    response: unknown;
    timestamp: string;
  }> = [];

  /** Wraps another provider and records all delegated calls. */
  public constructor(inner: EvalProvider) {
    invariant(
      inner.id.length > 0,
      'RecordingProvider inner provider id must not be empty',
    );
    invariant(
      typeof inner.detect === 'function',
      'RecordingProvider inner provider must implement detect()',
    );
    invariant(
      typeof inner.invokePlanMode === 'function',
      'RecordingProvider inner provider must implement invokePlanMode()',
    );
    invariant(
      typeof inner.invokeAgentMode === 'function',
      'RecordingProvider inner provider must implement invokeAgentMode()',
    );
    invariant(
      typeof inner.parse === 'function',
      'RecordingProvider inner provider must implement parse()',
    );
    this.inner = inner;
  }

  /** Delegates runtime detection and records the request/response pair. */
  public async detect(): Promise<ProviderRuntimeInfo> {
    return this.recordAsyncCall('detect', null, () => this.inner.detect());
  }

  /** Delegates plan-mode invocation and records the request/response pair. */
  public async invokePlanMode(
    request: ProviderPromptRequest,
  ): Promise<ProviderPromptResult> {
    return this.recordAsyncCall('invokePlanMode', request, () =>
      this.inner.invokePlanMode(request),
    );
  }

  /** Delegates agent-mode invocation and records the request/response pair. */
  public async invokeAgentMode(
    request: ProviderAgentRequest,
  ): Promise<ProviderAgentResult> {
    return this.recordAsyncCall('invokeAgentMode', request, () =>
      this.inner.invokeAgentMode(request),
    );
  }

  /** Delegates parse() and records the request/response pair. */
  public parse(raw: string): NormalizedProviderOutput {
    return this.recordSyncCall('parse', raw, () => this.inner.parse(raw));
  }

  /** Returns a snapshot of the recorded provider interactions. */
  public getRecordings(): Array<{
    method: string;
    request: unknown;
    response: unknown;
    timestamp: string;
  }> {
    return [...this.recordings];
  }

  /** Clears all previously recorded provider interactions. */
  public clearRecordings(): void {
    this.recordings.length = 0;
  }

  private async recordAsyncCall<T>(
    method: string,
    request: unknown,
    callback: () => Promise<T>,
  ): Promise<T> {
    const timestamp = new Date().toISOString();

    try {
      const response = await callback();
      this.recordings.push({ method, request, response, timestamp });
      return response;
    } catch (error) {
      this.recordings.push({
        method,
        request,
        response: this.serializeError(error),
        timestamp,
      });
      throw error;
    }
  }

  private recordSyncCall<T>(
    method: string,
    request: unknown,
    callback: () => T,
  ): T {
    const timestamp = new Date().toISOString();

    try {
      const response = callback();
      this.recordings.push({ method, request, response, timestamp });
      return response;
    } catch (error) {
      this.recordings.push({
        method,
        request,
        response: this.serializeError(error),
        timestamp,
      });
      throw error;
    }
  }

  private serializeError(error: unknown): Record<string, string> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      };
    }

    return {
      name: 'Error',
      message: String(error),
    };
  }
}

/** Fixture-backed provider that replays pre-recorded runtime and result payloads. */
export class FixtureProvider implements EvalProvider {
  public readonly id = 'fixture';

  private readonly config: ProviderConfig;
  private readonly fixtureDir: string;
  private readonly normalizedCache = new Map<
    string,
    NormalizedProviderOutput
  >();
  private lastCaseId: string | undefined;

  /** Creates a fixture provider rooted at the supplied fixture directory. */
  public constructor(
    config: Omit<Partial<ProviderConfig>, 'capabilities'> & {
      capabilities?: Partial<ProviderCapabilities>;
      fixtureDir: string;
    },
  ) {
    invariant(
      config.providerId === undefined || config.providerId === this.id,
      'FixtureProvider config.providerId must be fixture when provided',
    );
    assertString(
      config.fixtureDir,
      'FixtureProvider requires config.fixtureDir to be a string',
    );
    invariant(
      config.fixtureDir.length > 0,
      'FixtureProvider requires a non-empty fixtureDir',
    );

    const { fixtureDir, capabilities, ...baseConfig } = config;
    this.fixtureDir = fixtureDir;
    this.config = parseProviderConfig(
      {
        ...DEFAULT_FIXTURE_CONFIG,
        ...baseConfig,
        command: baseConfig.command ?? DEFAULT_FIXTURE_CONFIG.command,
        capabilities: mergeCapabilities(
          DEFAULT_FIXTURE_CAPABILITIES,
          capabilities,
        ),
      },
      'Invalid fixture provider config',
    );
  }

  /** Loads and validates runtime metadata from runtime-info.json. */
  public async detect(): Promise<ProviderRuntimeInfo> {
    const rawRuntimeInfo = await this.readRequiredJsonFile('runtime-info.json');
    return this.coerceRuntimeInfo(rawRuntimeInfo, 'runtime-info.json');
  }

  /** Loads and validates a prompt-mode fixture result for the request case. */
  public async invokePlanMode(
    request: ProviderPromptRequest,
  ): Promise<ProviderPromptResult> {
    const parsedRequest = parsePromptRequest(
      request,
      'Invalid fixture provider plan-mode request',
    );

    const caseId = extractCaseId(parsedRequest);
    this.lastCaseId = caseId;
    const normalizedOverride = await this.loadNormalizedFixture(caseId);
    const rawResult = await this.readRequiredJsonFile(
      path.join('responses', `${caseId}.json`),
    );
    const runtime = await this.detect();
    const result = this.coercePromptResult(
      rawResult,
      parsedRequest,
      runtime,
      normalizedOverride,
      path.join('responses', `${caseId}.json`),
    );
    this.normalizedCache.set(caseId, result.normalized);
    return result;
  }

  /** Loads and validates an agent-mode fixture result for the request case. */
  public async invokeAgentMode(
    request: ProviderAgentRequest,
  ): Promise<ProviderAgentResult> {
    const parsedRequest = parseAgentRequest(
      request,
      'Invalid fixture provider agent-mode request',
    );

    const caseId = extractCaseId(parsedRequest);
    this.lastCaseId = caseId;
    const normalizedOverride = await this.loadNormalizedFixture(caseId);
    const rawResult = await this.readRequiredJsonFile(
      path.join('agent-results', `${caseId}.json`),
    );
    const runtime = await this.detect();
    const result = this.coerceAgentResult(
      rawResult,
      parsedRequest,
      runtime,
      normalizedOverride,
      path.join('agent-results', `${caseId}.json`),
    );
    this.normalizedCache.set(caseId, result.normalized);
    return result;
  }

  /** Returns a cached normalized fixture output or falls back to pass-through parsing. */
  public parse(raw: string): NormalizedProviderOutput {
    assertString(raw, 'FixtureProvider.parse raw input must be a string');
    if (this.lastCaseId !== undefined) {
      const cachedOutput = this.normalizedCache.get(this.lastCaseId);
      if (cachedOutput !== undefined) {
        return cachedOutput;
      }
    }

    return buildPassThroughNormalizedOutput(raw);
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async readRequiredJsonFile(relativePath: string): Promise<unknown> {
    const filePath = path.join(this.fixtureDir, relativePath);
    const exists = await this.pathExists(filePath);
    invariant(exists, `Fixture file does not exist: ${filePath}`);

    const contents = await readFile(filePath, 'utf8');
    try {
      return JSON.parse(contents) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failInvariant(
        `Fixture file contains invalid JSON: ${filePath}: ${message}`,
      );
    }
  }

  private async loadNormalizedFixture(
    caseId: string,
  ): Promise<NormalizedProviderOutput | undefined> {
    const relativePath = path.join('normalized', `${caseId}.json`);
    const filePath = path.join(this.fixtureDir, relativePath);
    const exists = await this.pathExists(filePath);
    if (!exists) {
      return undefined;
    }

    const rawNormalizedOutput = await this.readRequiredJsonFile(relativePath);
    const normalizedOutput = this.coerceNormalizedOutput(
      rawNormalizedOutput,
      relativePath,
    );
    this.normalizedCache.set(caseId, normalizedOutput);
    return normalizedOutput;
  }

  private coerceRuntimeInfo(
    rawRuntimeInfo: unknown,
    sourceLabel: string,
  ): ProviderRuntimeInfo {
    const parsedRuntimeInfo =
      ProviderRuntimeInfoSchema.safeParse(rawRuntimeInfo);
    if (parsedRuntimeInfo.success) {
      return parsedRuntimeInfo.data as ProviderRuntimeInfo;
    }

    invariant(
      isRecord(rawRuntimeInfo),
      `Invalid fixture runtime info in ${sourceLabel}: expected an object`,
    );

    const runtimeId =
      typeof rawRuntimeInfo.id === 'string' && rawRuntimeInfo.id.length > 0
        ? rawRuntimeInfo.id
        : this.id;
    const runtimeModel =
      typeof rawRuntimeInfo.model === 'string' &&
      rawRuntimeInfo.model.length > 0
        ? rawRuntimeInfo.model
        : this.config.defaultModelId;
    const runtimeVersion =
      typeof rawRuntimeInfo.version === 'string' &&
      rawRuntimeInfo.version.length > 0
        ? rawRuntimeInfo.version
        : 'fixture';
    const runtimeCapabilities = this.coerceCapabilities(
      rawRuntimeInfo.capabilities,
      `${sourceLabel} capabilities`,
    );
    const metadataNotes =
      rawRuntimeInfo.metadata === undefined
        ? []
        : [`metadata: ${safeStringify(rawRuntimeInfo.metadata)}`];

    return parseRuntimeInfo(
      {
        providerId: runtimeId,
        available: true,
        detectedAt: new Date().toISOString(),
        version: runtimeVersion,
        commandPath: this.config.command[0],
        ...(runtimeModel === undefined ? {} : { defaultModelId: runtimeModel }),
        capabilities: runtimeCapabilities,
        notes: metadataNotes,
      },
      `Invalid fixture runtime info in ${sourceLabel}`,
    );
  }

  private coerceCapabilities(
    rawCapabilities: unknown,
    sourceLabel: string,
  ): ProviderCapabilities {
    const parsedCapabilities =
      ProviderCapabilitiesSchema.safeParse(rawCapabilities);
    if (parsedCapabilities.success) {
      return parsedCapabilities.data;
    }

    invariant(
      isRecord(rawCapabilities),
      `Invalid fixture provider capabilities in ${sourceLabel}: expected an object`,
    );
    invariant(
      typeof rawCapabilities.planMode === 'boolean',
      `Invalid fixture provider capabilities in ${sourceLabel}: planMode must be boolean`,
    );
    invariant(
      typeof rawCapabilities.agentMode === 'boolean',
      `Invalid fixture provider capabilities in ${sourceLabel}: agentMode must be boolean`,
    );
    invariant(
      typeof rawCapabilities.transcriptNormalization === 'boolean',
      `Invalid fixture provider capabilities in ${sourceLabel}: transcriptNormalization must be boolean`,
    );
    invariant(
      typeof rawCapabilities.fixturePlayback === 'boolean',
      `Invalid fixture provider capabilities in ${sourceLabel}: fixturePlayback must be boolean`,
    );

    return parseProviderConfig(
      {
        ...DEFAULT_FIXTURE_CONFIG,
        capabilities: {
          supportsDetect: true,
          supportsPlanMode: rawCapabilities.planMode,
          supportsAgentMode: rawCapabilities.agentMode,
          supportsStreaming: false,
          supportsToolCalls: false,
          supportsTranscriptCapture:
            rawCapabilities.transcriptNormalization ||
            rawCapabilities.fixturePlayback,
        },
      },
      `Invalid fixture provider capabilities in ${sourceLabel}`,
    ).capabilities;
  }

  private coerceNormalizedOutput(
    rawOutput: unknown,
    sourceLabel: string,
  ): NormalizedProviderOutput {
    const parsedOutput = NormalizedProviderOutputSchema.safeParse(rawOutput);
    if (parsedOutput.success) {
      return parsedOutput.data as NormalizedProviderOutput;
    }

    invariant(
      isRecord(rawOutput),
      `Invalid normalized output fixture in ${sourceLabel}: expected an object`,
    );
    invariant(
      typeof rawOutput.rawText === 'string',
      `Invalid normalized output fixture in ${sourceLabel}: rawText must be a string`,
    );
    invariant(
      typeof rawOutput.normalizedText === 'string',
      `Invalid normalized output fixture in ${sourceLabel}: normalizedText must be a string`,
    );

    const toolCalls = rawOutput.toolCalls;
    invariant(
      toolCalls === undefined ||
        (Array.isArray(toolCalls) && toolCalls.every((item) => isRecord(item))),
      `Invalid normalized output fixture in ${sourceLabel}: toolCalls must be an array of objects`,
    );

    const referencedSkills =
      typeof rawOutput.skillDetected === 'string' &&
      rawOutput.skillDetected.length > 0
        ? [rawOutput.skillDetected]
        : [];
    const selectedSkill =
      rawOutput.skillDetected === 'none' ||
      rawOutput.skillDetected === 'agent-tty' ||
      rawOutput.skillDetected === 'dogfood-tui'
        ? rawOutput.skillDetected
        : undefined;
    const tokenUsage = coerceOptionalTokenUsage(rawOutput.tokenUsage);

    return parseNormalizedOutput(
      {
        finalText: rawOutput.normalizedText,
        messages:
          rawOutput.rawText === rawOutput.normalizedText
            ? [rawOutput.rawText]
            : [rawOutput.rawText, rawOutput.normalizedText],
        referencedSkills,
        ...(selectedSkill === undefined ? {} : { selectedSkill }),
        toolCalls: toolCalls ?? [],
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
      },
      `Invalid normalized output fixture in ${sourceLabel}`,
    );
  }

  private coercePromptResult(
    rawResult: unknown,
    request: ProviderPromptRequest,
    runtime: ProviderRuntimeInfo,
    normalizedOverride: NormalizedProviderOutput | undefined,
    sourceLabel: string,
  ): ProviderPromptResult {
    const parsedPromptResult = ProviderPromptResultSchema.safeParse(rawResult);
    if (parsedPromptResult.success) {
      return parsePromptResult(
        {
          ...parsedPromptResult.data,
          request,
          runtime,
          normalized: normalizedOverride ?? parsedPromptResult.data.normalized,
        },
        `Invalid prompt result fixture in ${sourceLabel}`,
      );
    }

    invariant(
      isRecord(rawResult),
      `Invalid prompt result fixture in ${sourceLabel}: expected an object`,
    );
    invariant(
      typeof rawResult.response === 'string',
      `Invalid prompt result fixture in ${sourceLabel}: response must be a string`,
    );

    const durationMs = this.coerceDurationMs(rawResult.latencyMs);
    const startedAtMs = Date.now();
    const completedAtMs = startedAtMs + durationMs;
    const tokenUsage = coerceOptionalTokenUsage(rawResult.tokenUsage);
    const normalized =
      normalizedOverride ??
      buildPassThroughNormalizedOutput(rawResult.response, tokenUsage);
    const adaptedRuntime =
      typeof rawResult.model === 'string' && rawResult.model.length > 0
        ? parseRuntimeInfo(
            {
              ...runtime,
              defaultModelId: rawResult.model,
            },
            `Invalid prompt runtime fixture in ${sourceLabel}`,
          )
        : runtime;

    return parsePromptResult(
      {
        request,
        runtime: adaptedRuntime,
        ok: true,
        exitCode: 0,
        signal: null,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs,
        rawStdout: rawResult.response,
        rawStderr: '',
        normalized,
      },
      `Invalid prompt result fixture in ${sourceLabel}`,
    );
  }

  private coerceAgentResult(
    rawResult: unknown,
    request: ProviderAgentRequest,
    runtime: ProviderRuntimeInfo,
    normalizedOverride: NormalizedProviderOutput | undefined,
    sourceLabel: string,
  ): ProviderAgentResult {
    const parsedAgentResult = ProviderAgentResultSchema.safeParse(rawResult);
    if (parsedAgentResult.success) {
      return parseAgentResult(
        {
          ...parsedAgentResult.data,
          request,
          runtime,
          normalized: normalizedOverride ?? parsedAgentResult.data.normalized,
        },
        `Invalid agent result fixture in ${sourceLabel}`,
      );
    }

    invariant(
      isRecord(rawResult),
      `Invalid agent result fixture in ${sourceLabel}: expected an object`,
    );
    invariant(
      typeof rawResult.transcript === 'string',
      `Invalid agent result fixture in ${sourceLabel}: transcript must be a string`,
    );

    const exitCode = this.coerceExitCode(rawResult.exitCode);
    const durationMs = this.coerceDurationMs(rawResult.durationMs);
    const errorLines = this.coerceErrorLines(rawResult.errors, sourceLabel);
    const startedAtMs = Date.now();
    const completedAtMs = startedAtMs + durationMs;
    const tokenUsage = coerceOptionalTokenUsage(rawResult.tokenUsage);
    const normalized =
      normalizedOverride ??
      buildPassThroughNormalizedOutput(rawResult.transcript, tokenUsage);

    return parseAgentResult(
      {
        request,
        runtime,
        ok: exitCode === 0 && errorLines.length === 0,
        exitCode,
        signal: null,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs,
        rawStdout: rawResult.transcript,
        rawStderr: errorLines.join('\n'),
        normalized,
        ...(errorLines.length === 0
          ? {}
          : { errorMessage: errorLines.join('\n') }),
      },
      `Invalid agent result fixture in ${sourceLabel}`,
    );
  }

  private coerceDurationMs(rawDuration: unknown): number {
    if (rawDuration === undefined) {
      return 0;
    }

    invariant(
      typeof rawDuration === 'number' &&
        Number.isFinite(rawDuration) &&
        rawDuration >= 0,
      'fixture duration must be a finite non-negative number',
    );
    return Math.round(rawDuration);
  }

  private coerceExitCode(rawExitCode: unknown): number {
    if (rawExitCode === undefined) {
      return 0;
    }

    invariant(
      typeof rawExitCode === 'number' && Number.isInteger(rawExitCode),
      'fixture exitCode must be an integer when provided',
    );
    return rawExitCode;
  }

  private coerceErrorLines(rawErrors: unknown, sourceLabel: string): string[] {
    if (rawErrors === undefined) {
      return [];
    }

    invariant(
      Array.isArray(rawErrors) &&
        rawErrors.every((value) => typeof value === 'string'),
      `Invalid agent result fixture in ${sourceLabel}: errors must be an array of strings`,
    );
    return rawErrors;
  }
}

/** Creates a stub provider with optional config overrides. */
export function createStubProvider(
  overrides: Omit<Partial<ProviderConfig>, 'capabilities' | 'cannedOutputs'> & {
    capabilities?: Partial<ProviderCapabilities>;
    cannedOutputs?: Record<string, NormalizedProviderOutput> & {
      __error?: string;
    };
  } = {},
): StubProvider {
  return new StubProvider(overrides);
}

/** Wraps a provider in a recording decorator. */
export function createRecordingProvider(
  inner: EvalProvider,
): RecordingProvider {
  return new RecordingProvider(inner);
}

/** Creates a fixture-backed provider rooted at the supplied directory. */
export function createFixtureProvider(fixtureDir: string): FixtureProvider {
  return new FixtureProvider({ fixtureDir });
}
