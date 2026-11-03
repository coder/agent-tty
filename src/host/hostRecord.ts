import { readFileSync, readlinkSync } from 'node:fs';
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
// host's pid namespace on the host's machine, and /proc shows that start
// time with the boottime offset of the reader's time namespace.
const HostRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    bootId: z.string().min(1),
    startTicks: z.string().regex(/^\d+$/),
    pidNamespace: z.string().min(1),
    timeNamespace: z.string().min(1).nullable().optional(),
    machineId: z.string().min(1).nullable().optional(),
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
          timeNamespace: readTimeNamespace(pid),
          machineId: readMachineId(),
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

// null on a kernel without time namespaces.
function readTimeNamespace(pid: number | 'self'): string | null {
  try {
    return readlinkSync(`/proc/${String(pid)}/ns/time`);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function inTimeNamespace(timeNamespace: string | null | undefined): boolean {
  if (timeNamespace === undefined) {
    return true;
  }
  try {
    return readTimeNamespace('self') === timeNamespace;
  } catch {
    return false;
  }
}

// null when no file names the machine, as in many container images.
function readMachineId(): string | null {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const machineId = readFileSync(path, 'utf8').trim();
      if (machineId.length > 0) {
        return machineId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function inHostPidSpace(record: HostRecord): boolean {
  return (
    inPidNamespace(record.pidNamespace) &&
    (record.machineId === undefined || readMachineId() === record.machineId)
  );
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

export async function sharesHostPids(
  sessionDirectory: string,
): Promise<boolean> {
  if (process.platform !== 'linux') {
    return true;
  }
  const record = await readHostRecord(sessionDirectory);
  return record === null || inHostPidSpace(record);
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
    !inHostPidSpace(record)
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
  if (
    record === null ||
    record.pid !== pid ||
    bootId === null ||
    !inTimeNamespace(record.timeNamespace)
  ) {
    return 'unknown';
  }
  return record.bootId === bootId && record.startTicks === stat.startTicks
    ? 'alive'
    : 'dead';
}
