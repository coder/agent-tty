import { readlinkSync } from 'node:fs';
import process from 'node:process';

import { z } from 'zod';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  readValidatedJsonFile,
  writeValidatedJsonFileSync,
} from '../storage/manifests.js';
import { hostRecordPath } from '../storage/sessionPaths.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import { readBootId, readProcStat } from './programGroup.js';

// A pid can name a new process after the host ends, but not with the host's
// start time on the same boot. The pid means that process only in the
// host's pid namespace.
export const HostRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    bootId: z.string().min(1),
    startTicks: z.string().regex(/^\d+$/),
    pidNamespace: z.string().min(1),
  })
  .strict();

export type HostRecord = z.infer<typeof HostRecordSchema>;

export type HostVerdict = 'alive' | 'dead' | 'unknown';

function validateHostRecord(path: string, data: unknown): HostRecord {
  const parsed = HostRecordSchema.safeParse(data);
  if (parsed.success) {
    return parsed.data;
  }

  throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
    message: `Host record validation failed for ${path}.`,
    details: { path, issues: parsed.error.issues },
  });
}

export function captureHost(pid: number): HostRecord | null {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const stat = readProcStat(pid);
    const bootId = readBootId();
    const pidNamespace = readlinkSync(`/proc/${String(pid)}/ns/pid`);
    return stat === null || bootId === null
      ? null
      : {
          version: 1,
          pid,
          bootId,
          startTicks: stat.startTicks,
          pidNamespace,
        };
  } catch {
    return null;
  }
}

function inPidNamespace(pidNamespace: string): boolean {
  try {
    return readlinkSync('/proc/self/ns/pid') === pidNamespace;
  } catch {
    return false;
  }
}

export function writeHostRecord(
  sessionDirectory: string,
  record: HostRecord,
): void {
  const path = hostRecordPath(sessionDirectory);
  writeValidatedJsonFileSync({
    path,
    pathLabel: 'host record path',
    data: record,
    writeErrorMessage: `Failed to write the host record at ${path}.`,
    validate: validateHostRecord,
    createParentFolders: false,
  });
}

export async function readHostRecord(
  sessionDirectory: string,
): Promise<HostRecord | null> {
  const path = hostRecordPath(sessionDirectory);
  try {
    return await readValidatedJsonFile({
      path,
      pathLabel: 'host record path',
      allowMissing: true,
      readErrorMessage: `Failed to read the host record at ${path}.`,
      invalidJsonMessage: `The host record contains invalid JSON at ${path}.`,
      validate: validateHostRecord,
    });
  } catch {
    return null;
  }
}

// A pid that the host recorded names another process, if any, in a pid
// namespace other than the host's. Without a host record, from a session
// that predates it, the CLI cannot tell and trusts the pid as before.
export async function sharesHostPidNamespace(
  sessionDirectory: string,
): Promise<boolean> {
  if (process.platform !== 'linux') {
    return true;
  }
  const record = await readHostRecord(sessionDirectory);
  return record === null || inPidNamespace(record.pidNamespace);
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return false;
    }
    if (hasErrorCode(error, 'EPERM')) {
      return true;
    }
    throw error;
  }
}

export function judgeHost(pid: number, record: HostRecord | null): HostVerdict {
  if (
    process.platform === 'linux' &&
    record !== null &&
    !inPidNamespace(record.pidNamespace)
  ) {
    return 'unknown';
  }
  if (!pidExists(pid)) {
    return 'dead';
  }
  if (process.platform !== 'linux') {
    return 'unknown';
  }
  let stat: ReturnType<typeof readProcStat>;
  let bootId: string | null;
  try {
    stat = readProcStat(pid);
    bootId = readBootId();
  } catch {
    return 'unknown';
  }
  if (stat === null) {
    return pidExists(pid) ? 'unknown' : 'dead';
  }
  if (stat.state === 'Z' || stat.state === 'X') {
    return 'dead';
  }
  if (record === null || record.pid !== pid || bootId === null) {
    return 'unknown';
  }
  return record.bootId === bootId && record.startTicks === stat.startTicks
    ? 'alive'
    : 'dead';
}
