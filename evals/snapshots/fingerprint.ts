import { createHash } from 'node:crypto';

import {
  AntiPatternRuleSchema,
  EvalCaseSchema,
  WorkflowCheckSchema,
} from '../lib/schemas.js';
import { invariant, unreachable } from '../../src/util/assert.js';
import type { z } from 'zod';

import type { AntiPatternRule, EvalCase } from '../lib/types.js';

type WorkflowCheckInput = z.infer<typeof WorkflowCheckSchema>;
type AntiPatternRuleInput = z.infer<typeof AntiPatternRuleSchema>;

interface FingerprintWorkflowCheck {
  id: string;
  requiredPatterns: string[];
  forbiddenPatterns: string[];
  dependsOn: string[];
}

interface FingerprintAntiPattern {
  id: string;
  patterns: string[];
  severity: AntiPatternRule['severity'];
  lanes?: AntiPatternRule['lanes'];
}

interface FingerprintCaseCommon {
  id: string;
  lane: EvalCase['lane'];
  category: EvalCase['category'];
  prompt: string;
  workflowChecks: FingerprintWorkflowCheck[];
  antiPatterns: FingerprintAntiPattern[];
}

interface FingerprintPromptCase extends FingerprintCaseCommon {
  lane: 'prompt';
  expectedPatterns: string[];
  forbiddenPatterns: string[];
}

type FingerprintCase = FingerprintPromptCase | FingerprintCaseCommon;

function projectWorkflowCheck(
  check: WorkflowCheckInput,
): FingerprintWorkflowCheck {
  return {
    id: check.id,
    requiredPatterns: [...check.requiredPatterns],
    forbiddenPatterns: [...check.forbiddenPatterns],
    dependsOn: [...check.dependsOn],
  };
}

function projectAntiPattern(
  rule: AntiPatternRuleInput,
): FingerprintAntiPattern {
  return {
    id: rule.id,
    patterns: [...rule.patterns],
    severity: rule.severity,
    ...(rule.lanes === undefined ? {} : { lanes: [...rule.lanes] }),
  };
}

function projectCaseSemanticFields(evalCase: EvalCase): FingerprintCase {
  const parsedCase = EvalCaseSchema.safeParse(evalCase);
  if (!parsedCase.success) {
    invariant(false, `Invalid eval case: ${parsedCase.error.message}`);
  }

  const baseCase: FingerprintCaseCommon = {
    id: parsedCase.data.id,
    lane: parsedCase.data.lane,
    category: parsedCase.data.category,
    prompt: parsedCase.data.prompt,
    workflowChecks: parsedCase.data.workflowChecks.map(projectWorkflowCheck),
    antiPatterns: parsedCase.data.antiPatterns.map(projectAntiPattern),
  };

  switch (parsedCase.data.lane) {
    case 'prompt':
      return {
        ...baseCase,
        lane: 'prompt',
        expectedPatterns: [...parsedCase.data.expectedPatterns],
        forbiddenPatterns: [...parsedCase.data.forbiddenPatterns],
      };
    case 'execution':
    case 'dogfood':
      return baseCase;
    default:
      return unreachable(parsedCase.data, 'Unsupported eval case lane');
  }
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          normalizeForStableJson((value as Record<string, unknown>)[key]),
        ]),
    );
  }

  return value;
}

export function caseFingerprint(evalCase: EvalCase): string {
  const serializedCase = JSON.stringify(
    normalizeForStableJson(projectCaseSemanticFields(evalCase)),
  );
  invariant(
    serializedCase !== undefined,
    'Snapshot fingerprint payload must serialize to JSON',
  );

  return createHash('sha256').update(serializedCase).digest('hex');
}
