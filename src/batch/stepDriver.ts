import type { z } from 'zod';

import type { RunResult, WaitForRenderResult } from '../protocol/messages.js';
import type { PreparedRenderWaitCondition } from '../renderWait/matcher.js';

import { sendRpc } from '../host/rpcClient.js';
import {
  PasteResultSchema,
  RunResultSchema,
  SendKeysResultSchema,
  TypeResultSchema,
  WaitForRenderResultSchema,
} from '../protocol/messages.js';
import { parseValidatedResult } from '../protocol/validation.js';
import { invariant } from '../util/assert.js';

/**
 * The seam the Batch executor drives, injected so it runs without a real PTY or
 * renderer. Input verbs resolve the Event Log seq they produced; `wait` takes a
 * prior seq back as `afterSeq` (the Wait Baseline).
 */
export interface StepDriver {
  type(text: string): Promise<number>;
  paste(text: string): Promise<number>;
  sendKeys(keys: string[]): Promise<number>;
  run(
    command: string,
    noWait: boolean,
    timeoutMs: number | undefined,
  ): Promise<RunResult>;
  wait(
    condition: PreparedRenderWaitCondition,
    afterSeq: number | undefined,
    timeoutMs: number | undefined,
  ): Promise<WaitForRenderResult>;
}

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const NO_WAIT_RUN_TRANSPORT_TIMEOUT_MS = 10_000;
const RUN_TRANSPORT_PADDING_MS = 10_000;
const WAIT_TRANSPORT_PADDING_MS = 5_000;

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  method: string,
): T {
  return parseValidatedResult(
    schema,
    raw,
    `Unexpected response shape from the session host for "${method}".`,
  );
}

// Build the strict `waitForRender` params: omit undefined optionals, drop the
// prepared `compiledRegex`, and take `afterSeq` from the Wait Baseline argument.
function buildWaitParams(
  condition: PreparedRenderWaitCondition,
  afterSeq: number | undefined,
  timeoutMs: number | undefined,
  rendererName: string | undefined,
): Record<string, unknown> {
  return {
    ...(condition.text === undefined ? {} : { text: condition.text }),
    ...(condition.regex === undefined ? {} : { regex: condition.regex }),
    ...(condition.screenStableMs === undefined
      ? {}
      : { screenStableMs: condition.screenStableMs }),
    ...(condition.cursorRow === undefined
      ? {}
      : { cursorRow: condition.cursorRow }),
    ...(condition.cursorCol === undefined
      ? {}
      : { cursorCol: condition.cursorCol }),
    ...(afterSeq === undefined ? {} : { afterSeq }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(rendererName === undefined ? {} : { rendererName }),
  };
}

/**
 * The production StepDriver: each verb is one RPC, with transport timeouts that
 * pad the host's own deadline. Unlike `runWaitCommand` it does NOT fall back to
 * offline replay — a dead host mid-Batch is a failed step, so the CliError
 * propagates for the executor to classify.
 */
export function createRpcStepDriver(
  socketPath: string,
  rendererName?: string,
): StepDriver {
  invariant(socketPath.length > 0, 'socketPath must be a non-empty string');

  return {
    async type(text: string): Promise<number> {
      const raw = await sendRpc(socketPath, 'type', { text });
      return parseOrThrow(TypeResultSchema, raw, 'type').seq;
    },

    async paste(text: string): Promise<number> {
      const raw = await sendRpc(socketPath, 'paste', { text });
      return parseOrThrow(PasteResultSchema, raw, 'paste').seq;
    },

    async sendKeys(keys: string[]): Promise<number> {
      const raw = await sendRpc(socketPath, 'sendKeys', { keys });
      return parseOrThrow(SendKeysResultSchema, raw, 'sendKeys').seq;
    },

    async run(
      command: string,
      noWait: boolean,
      timeoutMs: number | undefined,
    ): Promise<RunResult> {
      const params: Record<string, unknown> = { command, noWait };
      if (!noWait && timeoutMs !== undefined) {
        params.timeoutMs = timeoutMs;
      }
      const transportTimeoutMs = noWait
        ? NO_WAIT_RUN_TRANSPORT_TIMEOUT_MS
        : (timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS) + RUN_TRANSPORT_PADDING_MS;
      const raw = await sendRpc(socketPath, 'run', params, transportTimeoutMs);
      return parseOrThrow(RunResultSchema, raw, 'run');
    },

    async wait(
      condition: PreparedRenderWaitCondition,
      afterSeq: number | undefined,
      timeoutMs: number | undefined,
    ): Promise<WaitForRenderResult> {
      const params = buildWaitParams(
        condition,
        afterSeq,
        timeoutMs,
        rendererName,
      );
      // timeoutMs undefined means an infinite wait (0 -> infinite transport).
      const transportTimeoutMs =
        timeoutMs === undefined ? 0 : timeoutMs + WAIT_TRANSPORT_PADDING_MS;
      const raw = await sendRpc(
        socketPath,
        'waitForRender',
        params,
        transportTimeoutMs,
      );
      return parseOrThrow(WaitForRenderResultSchema, raw, 'waitForRender');
    },
  };
}
