import { z } from 'zod';

import type { PreparedRenderWaitCondition } from '../renderWait/matcher.js';

import { assertValidKeyName } from '../pty/keyEncoder.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { prepareRenderWaitCondition } from '../renderWait/matcher.js';
import { invariant, unreachable } from '../util/assert.js';

export type BatchStep =
  | { kind: 'type'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'sendKeys'; keys: string[] }
  | {
      kind: 'run';
      command: string;
      noWait: boolean;
      timeoutMs: number | undefined;
    }
  | {
      kind: 'wait';
      condition: PreparedRenderWaitCondition;
      timeoutMs: number | undefined;
    };

export interface BatchPlan {
  steps: BatchStep[];
}

const VERB_KEYS = ['type', 'paste', 'sendKeys', 'run', 'wait'] as const;

type VerbKey = (typeof VERB_KEYS)[number];

const TypeStepSchema = z.object({ type: z.string().min(1) }).strict();
const PasteStepSchema = z.object({ paste: z.string().min(1) }).strict();
const SendKeysStepSchema = z
  .object({ sendKeys: z.array(z.string().min(1)).min(1) })
  .strict();
const RunStepSchema = z
  .object({
    run: z.string().min(1),
    noWait: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strict();
const WaitStepSchema = z
  .object({
    wait: z
      .object({
        text: z.string().optional(),
        regex: z.string().optional(),
        screenStableMs: z.number().int().positive().optional(),
        cursorRow: z.number().int().nonnegative().optional(),
        cursorCol: z.number().int().nonnegative().optional(),
        timeout: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

function invalidInput(message: string, stepIndex?: number): never {
  throw makeCliError(ERROR_CODES.INVALID_INPUT, {
    message,
    ...(stepIndex === undefined ? {} : { details: { stepIndex } }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presentVerbKeys(step: Record<string, unknown>): VerbKey[] {
  return VERB_KEYS.filter((key) => Object.hasOwn(step, key));
}

function parseStep(rawStep: unknown, index: number): BatchStep {
  if (!isPlainObject(rawStep)) {
    return invalidInput(
      `Batch step ${String(index)} must be a JSON object`,
      index,
    );
  }

  const verbs = presentVerbKeys(rawStep);
  if (verbs.length === 0) {
    return invalidInput(
      `Batch step ${String(index)} must have exactly one of type|paste|sendKeys|run|wait; found none`,
      index,
    );
  }
  if (verbs.length > 1) {
    return invalidInput(
      `Batch step ${String(index)} must have exactly one of type|paste|sendKeys|run|wait; found ${verbs.join(', ')}`,
      index,
    );
  }

  const verb = verbs[0];
  invariant(verb !== undefined, 'exactly one verb key is present');

  switch (verb) {
    case 'type':
      return parseTypeStep(rawStep, index);
    case 'paste':
      return parsePasteStep(rawStep, index);
    case 'sendKeys':
      return parseSendKeysStep(rawStep, index);
    case 'run':
      return parseRunStep(rawStep, index);
    case 'wait':
      return parseWaitStep(rawStep, index);
    default:
      return unreachable(verb, `Batch step ${String(index)} verb dispatch`);
  }
}

function unwrapStep<T>(
  schema: z.ZodType<T>,
  rawStep: unknown,
  index: number,
): T {
  const result = schema.safeParse(rawStep);
  if (!result.success) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: `Batch step ${String(index)} is invalid`,
      details: { stepIndex: index, issues: result.error.issues },
    });
  }
  return result.data;
}

function parseTypeStep(
  rawStep: Record<string, unknown>,
  index: number,
): BatchStep {
  const data = unwrapStep(TypeStepSchema, rawStep, index);
  return { kind: 'type', text: data.type };
}

function parsePasteStep(
  rawStep: Record<string, unknown>,
  index: number,
): BatchStep {
  const data = unwrapStep(PasteStepSchema, rawStep, index);
  return { kind: 'paste', text: data.paste };
}

function parseSendKeysStep(
  rawStep: Record<string, unknown>,
  index: number,
): BatchStep {
  const data = unwrapStep(SendKeysStepSchema, rawStep, index);

  const keys = data.sendKeys;
  for (const key of keys) {
    assertValidKeyName(key);
  }
  return { kind: 'sendKeys', keys };
}

function parseRunStep(
  rawStep: Record<string, unknown>,
  index: number,
): BatchStep {
  const { run, noWait, timeout } = unwrapStep(RunStepSchema, rawStep, index);
  return {
    kind: 'run',
    command: run,
    noWait: noWait ?? false,
    timeoutMs: timeout === undefined ? undefined : timeout,
  };
}

function parseWaitStep(
  rawStep: Record<string, unknown>,
  index: number,
): BatchStep {
  const { wait } = unwrapStep(WaitStepSchema, rawStep, index);
  const condition = prepareRenderWaitCondition({
    text: wait.text,
    regex: wait.regex,
    screenStableMs: wait.screenStableMs,
    cursorRow: wait.cursorRow,
    cursorCol: wait.cursorCol,
  });

  const timeoutMs =
    wait.timeout === undefined || wait.timeout === 0 ? undefined : wait.timeout;
  return { kind: 'wait', condition, timeoutMs };
}

/**
 * Parse a JSON string into a validated Batch Plan. Pure: no fs or rpc. Every
 * failure throws a CliError so the whole plan is rejected before any input is
 * sent (a Batch is not atomic).
 */
export function parseBatchPlan(raw: string): BatchPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidInput('Batch steps must be valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    return invalidInput('Batch steps must be a JSON array.');
  }

  if (parsed.length === 0) {
    return invalidInput('Batch must contain at least one step.');
  }

  const steps = parsed.map((rawStep, index) => parseStep(rawStep, index));
  return { steps };
}
