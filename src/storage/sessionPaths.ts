import crypto from 'node:crypto';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { EVENT_LOG_FILENAME, MANIFEST_FILENAME } from '../config/defaults.js';
import { invariant } from '../util/assert.js';

const SOCKET_ROOT_DIRECTORY = '/tmp/agent-tty';
const SOCKET_HOME_ID_LENGTH = 8;
const SOCKET_ID_LENGTH = 12;

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

function resolveSocketDirectory(home: string): string {
  assertAbsolutePath(home, 'home');

  const directory = resolve(
    SOCKET_ROOT_DIRECTORY,
    crypto
      .createHash('sha256')
      .update(resolve(home))
      .digest('hex')
      .slice(0, SOCKET_HOME_ID_LENGTH),
  );
  invariant(
    dirname(directory) === resolve(SOCKET_ROOT_DIRECTORY),
    'socket directory must stay within the socket root directory',
  );
  invariant(
    basename(directory).length === SOCKET_HOME_ID_LENGTH,
    'socket home identifier must have the expected length',
  );

  return directory;
}

function deriveSessionIdentity(sessionDirectory: string): {
  home: string;
  sessionId: string;
} {
  assertAbsolutePath(sessionDirectory, 'sessionDir');

  const normalizedSessionDirectory = resolve(sessionDirectory);
  const sessionId = basename(normalizedSessionDirectory);
  assertSessionId(sessionId);

  const sessionsRoot = dirname(normalizedSessionDirectory);
  const home = dirname(sessionsRoot);

  invariant(
    sessionsRoot === resolve(home, 'sessions'),
    'session directory must stay within the sessions root',
  );

  return {
    home,
    sessionId,
  };
}

function socketFileId(sessionId: string): string {
  assertSessionId(sessionId);

  const digest = crypto
    .createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, SOCKET_ID_LENGTH);
  invariant(
    digest.length === SOCKET_ID_LENGTH,
    'socket file identifier must have the expected length',
  );

  return digest;
}

export function socketPath(sessionDirectory: string): string {
  const { home, sessionId } = deriveSessionIdentity(sessionDirectory);
  const socketDirectory = resolveSocketDirectory(home);
  const socketFile = resolve(socketDirectory, socketFileId(sessionId));

  invariant(
    dirname(socketFile) === socketDirectory,
    'socket path must stay within the socket directory',
  );

  return socketFile;
}
