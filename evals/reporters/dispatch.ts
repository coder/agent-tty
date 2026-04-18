import type { ZodIssue } from 'zod';

import { assertString, invariant } from '../../src/util/assert.js';

import {
  EVENT_SCHEMAS,
  type Reporter,
  type ReporterEventName,
  type ReporterEventPayloads,
} from './types.js';

const REDACTED_VALUE = '[REDACTED]';
const SECRET_NAMES = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD'] as const;

const EVENT_HOOK_NAMES = {
  runStart: 'onRunStart',
  laneStart: 'onLaneStart',
  caseStart: 'onCaseStart',
  trialStart: 'onTrialStart',
  trialFinish: 'onTrialFinish',
  caseFinish: 'onCaseFinish',
  laneFinish: 'onLaneFinish',
  runFinish: 'onRunFinish',
} as const satisfies {
  [K in ReporterEventName]: Exclude<keyof Reporter, 'name'>;
};

type ReporterEventHook<K extends ReporterEventName> = (
  event: ReporterEventPayloads[K],
) => Promise<void> | void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shouldRedactKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return SECRET_NAMES.some(
    (name) => upperKey === name || upperKey.endsWith(`_${name}`),
  );
}

function formatValidationIssue(issue: ZodIssue): string {
  const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
  return `${path}: ${issue.message}`;
}

function formatReporterError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePayload<K extends ReporterEventName>(
  eventName: K,
  payload: unknown,
): ReporterEventPayloads[K] {
  const validation = EVENT_SCHEMAS[eventName].safeParse(payload);
  if (!validation.success) {
    const issues = validation.error.issues.map(formatValidationIssue).join('; ');
    throw new Error(
      `Invalid reporter payload for event "${eventName}": ${issues}`,
    );
  }

  return validation.data as ReporterEventPayloads[K];
}

function getReporterHook<K extends ReporterEventName>(
  reporter: Reporter,
  eventName: K,
): ReporterEventHook<K> | undefined {
  const hookName = EVENT_HOOK_NAMES[eventName];
  return reporter[hookName] as ReporterEventHook<K> | undefined;
}

export function redactSecretLikeValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretLikeValues(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      shouldRedactKey(key)
        ? REDACTED_VALUE
        : redactSecretLikeValues(nestedValue),
    ]),
  );
}

export class ReporterDispatcher {
  private readonly reporters: Reporter[];

  public constructor(reporters: readonly Reporter[] = []) {
    invariant(Array.isArray(reporters), 'reporters must be an array');

    const seenNames = new Set<string>();
    this.reporters = reporters.map((reporter, index) => {
      invariant(
        reporter !== null && reporter !== undefined,
        `reporters[${String(index)}] must not be null or undefined`,
      );
      assertString(
        reporter.name,
        `reporters[${String(index)}].name must be a string`,
      );
      invariant(
        reporter.name.length > 0,
        `reporters[${String(index)}].name must not be empty`,
      );
      invariant(
        !seenNames.has(reporter.name),
        `Duplicate reporter name: ${reporter.name}`,
      );
      seenNames.add(reporter.name);
      return reporter;
    });
  }

  public async dispatch<K extends ReporterEventName>(
    eventName: K,
    payload: ReporterEventPayloads[K],
  ): Promise<void> {
    const validatedPayload = validatePayload(eventName, payload);
    const redactedPayload = redactSecretLikeValues(
      validatedPayload,
    ) as ReporterEventPayloads[K];

    for (const reporter of this.reporters) {
      const hook = getReporterHook(reporter, eventName);
      if (hook === undefined) {
        continue;
      }

      try {
        await hook.call(reporter, redactedPayload);
      } catch (error) {
        process.stderr.write(
          `reporter "${reporter.name}" failed on ${eventName}: ${formatReporterError(error)}\n`,
        );
      }
    }
  }
}
