import { dirname, isAbsolute, resolve } from 'node:path';

import {
  EVENT_LOG_FILENAME,
  MANIFEST_FILENAME,
  SOCKET_FILENAME,
} from '../config/defaults.js';
import { invariant } from '../util/assert.js';

function assertNonEmptyString(
  value: string,
  label: string,
): asserts value is string {
  invariant(value.length > 0, `${label} must be a non-empty string`);
}

function assertAbsolutePath(pathValue: string, label: string): void {
  assertNonEmptyString(pathValue, label);
  invariant(isAbsolute(pathValue), `${label} must be an absolute path`);
}

function assertSessionId(sessionId: string): void {
  assertNonEmptyString(sessionId, 'sessionId');
  invariant(sessionId !== '.', 'sessionId must not be "."');
  invariant(sessionId !== '..', 'sessionId must not be ".."');
  invariant(
    !sessionId.includes('/') && !sessionId.includes('\\'),
    'sessionId must not contain path separators',
  );
}

export function sessionDir(home: string, sessionId: string): string {
  assertAbsolutePath(home, 'home');
  assertSessionId(sessionId);

  const sessionsRoot = resolve(home, 'sessions');
  const resolvedSessionDirectory = resolve(sessionsRoot, sessionId);

  invariant(
    dirname(resolvedSessionDirectory) === sessionsRoot,
    'session directory must stay within the sessions root',
  );

  return resolvedSessionDirectory;
}

function childPath(sessionDirectory: string, filename: string): string {
  assertAbsolutePath(sessionDirectory, 'sessionDir');

  const normalizedSessionDirectory = resolve(sessionDirectory);
  const child = resolve(normalizedSessionDirectory, filename);

  invariant(
    dirname(child) === normalizedSessionDirectory,
    `${filename} must stay within the session directory`,
  );

  return child;
}

export function manifestPath(sessionDirectory: string): string {
  return childPath(sessionDirectory, MANIFEST_FILENAME);
}

export function eventLogPath(sessionDirectory: string): string {
  return childPath(sessionDirectory, EVENT_LOG_FILENAME);
}

export function socketPath(sessionDirectory: string): string {
  return childPath(sessionDirectory, SOCKET_FILENAME);
}
