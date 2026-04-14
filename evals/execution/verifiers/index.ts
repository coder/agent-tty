import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SessionRecordSchema } from '../../../src/protocol/schemas.js';
import { manifestPath, sessionDir } from '../../../src/storage/sessionPaths.js';
import type { ArtifactKind } from '../../../src/tools/review-bundle.js';
import type { BundleValidationProfile } from '../../../src/tools/validate-bundle.js';
import { validateBundle } from '../../../src/tools/validate-bundle.js';
import { assertString, unreachable } from '../../../src/util/assert.js';
import { readEvalEvents } from '../../lib/cliHarness.js';
import { matchPatterns } from '../../lib/scoring.js';
import type { VerifierSpec } from '../../lib/types.js';

const ARTIFACT_MATCHERS: Record<ArtifactKind, RegExp[]> = {
  screenshot: [/\.png$/iu],
  video: [/\.webm$/iu],
  recording: [/\.cast$/iu],
  json: [/\.json$/iu],
  notes: [/\.md$/iu],
  script: [/\.(?:sh|bash|zsh|fish|ps1|cmd|bat)$/iu],
  support: [/.+/u],
  other: [/.+/u],
};

const CUSTOM_VALIDATORS = [
  'artifact-exists',
  'snapshot-contains',
  'event-log-check',
  'exit-code',
  'bundle-valid',
] as const;

type CustomValidator = (typeof CUSTOM_VALIDATORS)[number];

type ExitCodeLookup =
  | {
      source: 'event-log' | 'manifest';
      exitCode: number | null;
    }
  | undefined;

export interface VerifierContext {
  home: string;
  sessionId: string;
  transcript: string;
  artifacts: string[];
}

export interface VerifierResult {
  pass: boolean;
  message: string;
  details?: Record<string, unknown>;
}

function success(
  message: string,
  details?: Record<string, unknown>,
): VerifierResult {
  return details === undefined
    ? { pass: true, message }
    : { pass: true, message, details };
}

function failure(
  message: string,
  details?: Record<string, unknown>,
): VerifierResult {
  return details === undefined
    ? { pass: false, message }
    : { pass: false, message, details };
}

function readRequiredStringArray(
  config: Record<string, unknown>,
  key: string,
): string[] {
  const value = config[key];
  if (!Array.isArray(value)) {
    throw new Error(`Verifier config.${key} must be an array of strings`);
  }

  return value.map((entry, index) => {
    assertString(
      entry,
      `Verifier config.${key}[${String(index)}] must be a string`,
    );
    return entry;
  });
}

function readOptionalStringArray(
  config: Record<string, unknown>,
  key: string,
): string[] {
  const value = config[key];
  if (value === undefined) {
    return [];
  }

  return readRequiredStringArray(config, key);
}

function readOptionalInteger(
  config: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Verifier config.${key} must be an integer`);
  }

  return value;
}

function readRequiredInteger(
  config: Record<string, unknown>,
  key: string,
): number {
  const value = readOptionalInteger(config, key);
  if (value === undefined) {
    throw new Error(`Verifier config.${key} is required`);
  }
  return value;
}

function readOptionalString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }

  assertString(value, `Verifier config.${key} must be a string`);
  return value;
}

function readArtifactKind(value: unknown, label: string): ArtifactKind {
  assertString(value, `${label} must be a string`);
  if (!(value in ARTIFACT_MATCHERS)) {
    throw new Error(`${label} must be a supported artifact kind`);
  }

  return value as ArtifactKind;
}

function readRequestedArtifactKinds(
  config: Record<string, unknown>,
): ArtifactKind[] {
  const kinds = new Set<ArtifactKind>();

  if (config.kind !== undefined) {
    kinds.add(readArtifactKind(config.kind, 'Verifier config.kind'));
  }

  if (config.kinds !== undefined) {
    const requestedKinds = readRequiredStringArray(config, 'kinds');
    for (const kind of requestedKinds) {
      kinds.add(readArtifactKind(kind, 'Verifier config.kinds entry'));
    }
  }

  return [...kinds];
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function existingArtifacts(paths: readonly string[]): Promise<string[]> {
  const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
  const existing: string[] = [];

  for (const path of uniquePaths) {
    if (await fileExists(path)) {
      existing.push(path);
    }
  }

  return existing;
}

function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }

  return matchPatterns(path, [...patterns]).some((result) => result.matched);
}

async function readSessionExitCode(
  home: string,
  sessionId: string,
): Promise<ExitCodeLookup> {
  const events = readEvalEvents(home, sessionId);
  const exitEvent = [...events]
    .reverse()
    .find((event) => event.type === 'exit');
  if (exitEvent?.type === 'exit') {
    return {
      source: 'event-log',
      exitCode: exitEvent.payload.exitCode,
    };
  }

  const sessionManifestPath = manifestPath(sessionDir(home, sessionId));
  try {
    const rawManifest = await readFile(sessionManifestPath, 'utf8');
    const manifestCandidate = JSON.parse(rawManifest) as unknown;
    const parsedManifest = SessionRecordSchema.safeParse(manifestCandidate);
    if (!parsedManifest.success) {
      return undefined;
    }

    return {
      source: 'manifest',
      exitCode: parsedManifest.data.exitCode,
    };
  } catch {
    return undefined;
  }
}

function resolveCustomValidator(
  config: Record<string, unknown>,
): CustomValidator | undefined {
  const validator = readOptionalString(config, 'validator');
  if (validator === undefined) {
    return undefined;
  }

  if ((CUSTOM_VALIDATORS as readonly string[]).includes(validator)) {
    return validator as CustomValidator;
  }

  return undefined;
}

/** Dispatch a verifier spec against one execution transcript context. */
export async function verify(
  spec: VerifierSpec,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  switch (spec.kind) {
    case 'snapshot':
      return verifySnapshotContains(spec.config, ctx);
    case 'event-log':
      return verifyEventLogCheck(spec.config, ctx);
    case 'screenshot':
      return verifyArtifactExists({ kind: 'screenshot', ...spec.config }, ctx);
    case 'command':
      return verifyExitCode(spec.config, ctx);
    case 'bundle':
      return verifyBundleValid(spec.config, ctx);
    case 'json':
      return spec.config.patterns === undefined
        ? verifyArtifactExists({ kind: 'json', ...spec.config }, ctx)
        : verifySnapshotContains(spec.config, ctx);
    case 'custom': {
      const validator = resolveCustomValidator(spec.config);
      switch (validator) {
        case 'artifact-exists':
          return verifyArtifactExists(spec.config, ctx);
        case 'snapshot-contains':
          return verifySnapshotContains(spec.config, ctx);
        case 'event-log-check':
          return verifyEventLogCheck(spec.config, ctx);
        case 'exit-code':
          return verifyExitCode(spec.config, ctx);
        case 'bundle-valid':
          return verifyBundleValid(spec.config, ctx);
        case undefined:
          return failure(
            `Unsupported custom verifier for ${spec.id}: expected one of ${CUSTOM_VALIDATORS.join(', ')}`,
          );
        default:
          return unreachable(validator, 'unsupported custom validator');
      }
    }
    default:
      return unreachable(spec.kind, 'unsupported verifier kind');
  }
}

/** Verify that transcript content contains all required snapshot patterns. */
export function verifySnapshotContains(
  config: Record<string, unknown>,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  try {
    const patterns = readRequiredStringArray(config, 'patterns');
    const results = matchPatterns(ctx.transcript, patterns);
    const missingPatterns = results.filter((result) => !result.matched);
    if (missingPatterns.length > 0) {
      return Promise.resolve(
        failure(
          `Snapshot transcript missed ${String(missingPatterns.length)} required pattern(s).`,
          {
            missingPatterns: missingPatterns.map((result) => result.pattern),
            matches: results,
          },
        ),
      );
    }

    return Promise.resolve(
      success(
        `Matched all ${String(results.length)} required snapshot pattern(s).`,
        {
          matches: results,
        },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(failure(`Snapshot verification failed: ${message}`));
  }
}

/** Verify event-log content, event types, and output patterns for a session. */
export function verifyEventLogCheck(
  config: Record<string, unknown>,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  if (ctx.sessionId.trim().length === 0) {
    return Promise.resolve(
      failure(
        'Event-log verification requires a sessionId in the verifier context.',
      ),
    );
  }

  try {
    const requiredEventTypes = readOptionalStringArray(
      config,
      'requiredEventTypes',
    );
    const forbiddenEventTypes = readOptionalStringArray(
      config,
      'forbiddenEventTypes',
    );
    const requiredOutputPatterns = readOptionalStringArray(
      config,
      'requiredOutputPatterns',
    );
    const minEvents = readOptionalInteger(config, 'minEvents') ?? 1;
    const events = readEvalEvents(ctx.home, ctx.sessionId);
    if (events.length < minEvents) {
      return Promise.resolve(
        failure(
          `Expected at least ${String(minEvents)} event-log record(s), found ${String(events.length)}.`,
          {
            foundEventTypes: events.map((event) => event.type),
          },
        ),
      );
    }

    const eventTypes = new Set(events.map((event) => event.type));
    const missingEventTypes = requiredEventTypes.filter(
      (eventType) =>
        !eventTypes.has(eventType as (typeof events)[number]['type']),
    );
    if (missingEventTypes.length > 0) {
      return Promise.resolve(
        failure('Event log missed required event types.', {
          missingEventTypes,
          foundEventTypes: [...eventTypes],
        }),
      );
    }

    const presentForbiddenEventTypes = forbiddenEventTypes.filter((eventType) =>
      eventTypes.has(eventType as (typeof events)[number]['type']),
    );
    if (presentForbiddenEventTypes.length > 0) {
      return Promise.resolve(
        failure('Event log contained forbidden event types.', {
          presentForbiddenEventTypes,
          foundEventTypes: [...eventTypes],
        }),
      );
    }

    const outputText = events
      .filter((event) => event.type === 'output')
      .map((event) => event.payload.data)
      .join('');
    const outputMatches = matchPatterns(outputText, requiredOutputPatterns);
    const missingOutputPatterns = outputMatches.filter(
      (result) => !result.matched,
    );
    if (missingOutputPatterns.length > 0) {
      return Promise.resolve(
        failure('Event log output missed required transcript patterns.', {
          missingOutputPatterns: missingOutputPatterns.map(
            (result) => result.pattern,
          ),
          outputMatches,
        }),
      );
    }

    return Promise.resolve(
      success(
        `Event log satisfied ${String(requiredEventTypes.length)} required type check(s).`,
        {
          eventCount: events.length,
          foundEventTypes: [...eventTypes],
          outputMatches,
        },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve(
      failure(`Event-log verification failed: ${message}`),
    );
  }
}

/** Verify that expected artifact files exist in the collected artifact set. */
export async function verifyArtifactExists(
  config: Record<string, unknown>,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  try {
    const requestedKinds = readRequestedArtifactKinds(config);
    const pathPatterns = readOptionalStringArray(config, 'pathPatterns');
    const minCount = readOptionalInteger(config, 'minCount') ?? 1;
    const artifacts = await existingArtifacts(ctx.artifacts);
    if (artifacts.length === 0) {
      return failure('No artifact files were available to validate.');
    }

    if (requestedKinds.length === 0) {
      const matchingArtifacts = artifacts.filter((path) =>
        matchesAnyPattern(path, pathPatterns),
      );
      if (matchingArtifacts.length < minCount) {
        return failure(
          `Expected at least ${String(minCount)} matching artifact(s), found ${String(matchingArtifacts.length)}.`,
          {
            matchingArtifacts,
            artifacts,
          },
        );
      }

      return success(
        `Found ${String(matchingArtifacts.length)} matching artifact(s).`,
        {
          matchingArtifacts,
        },
      );
    }

    const matchedByKind: Record<string, string[]> = {};
    const missingKinds: ArtifactKind[] = [];
    for (const kind of requestedKinds) {
      const kindMatches = artifacts.filter((path) => {
        const kindMatch = ARTIFACT_MATCHERS[kind].some((pattern) =>
          pattern.test(path),
        );
        return kindMatch && matchesAnyPattern(path, pathPatterns);
      });
      matchedByKind[kind] = kindMatches;
      if (kindMatches.length < minCount) {
        missingKinds.push(kind);
      }
    }

    if (missingKinds.length > 0) {
      return failure('Missing one or more required artifact kinds.', {
        missingKinds,
        matchedByKind,
      });
    }

    return success(
      `Found required artifacts for ${requestedKinds.join(', ')}.`,
      {
        matchedByKind,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`Artifact verification failed: ${message}`);
  }
}

/** Verify the observed session exit code from the event log or manifest. */
export async function verifyExitCode(
  config: Record<string, unknown>,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  if (ctx.sessionId.trim().length === 0) {
    return failure(
      'Exit-code verification requires a sessionId in the verifier context.',
    );
  }

  try {
    const expectedExitCode = readRequiredInteger(config, 'expectedExitCode');
    const actualExitCode = await readSessionExitCode(ctx.home, ctx.sessionId);
    if (actualExitCode === undefined) {
      return failure(
        'Could not determine an exit code from the event log or manifest.',
      );
    }

    if (actualExitCode.exitCode !== expectedExitCode) {
      return failure(
        `Expected exit code ${String(expectedExitCode)}, observed ${String(actualExitCode.exitCode)}.`,
        {
          expectedExitCode,
          actualExitCode: actualExitCode.exitCode,
          source: actualExitCode.source,
        },
      );
    }

    return success(
      `Observed expected exit code ${String(expectedExitCode)} from the ${actualExitCode.source}.`,
      {
        expectedExitCode,
        source: actualExitCode.source,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`Exit-code verification failed: ${message}`);
  }
}

/** Validate a proof bundle directory against one of the built-in profiles. */
export async function verifyBundleValid(
  config: Record<string, unknown>,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  void ctx;
  try {
    const bundlePath = readOptionalString(config, 'bundlePath');
    if (bundlePath === undefined) {
      return failure('Bundle verification requires config.bundlePath.');
    }

    const profile =
      (readOptionalString(config, 'profile') as
        | BundleValidationProfile
        | undefined) ?? 'interactive-renderer';
    const validationResult = await validateBundle(resolve(bundlePath), profile);
    if (!validationResult.ok) {
      return failure('Bundle validation failed.', {
        profile,
        checks: validationResult.checks,
      });
    }

    return success('Bundle validation passed.', {
      profile,
      checks: validationResult.checks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`Bundle verification failed: ${message}`);
  }
}
