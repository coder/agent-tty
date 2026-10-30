import { readFileSync } from 'node:fs';
import process from 'node:process';

import { z } from 'zod';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { writeValidatedJsonFileSync } from '../storage/manifests.js';
import { programRecordPath } from '../storage/sessionPaths.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

// On Linux, setsid() gives the new session a new autogroup, whose id comes
// from a counter that never repeats within a boot, and fork() passes it on.
// So the boot id and the autogroup id name the program's session, also after
// the program exits. A later group that reuses its id has another autogroup.
// Without autogroups (macOS, Windows, some kernels) both are null.
const ProgramPidSchema = z.number().int().gt(1);
const ProgramRecordSchema = z.union([
  z
    .object({
      version: z.literal(1),
      pid: ProgramPidSchema,
      bootId: z.string().min(1),
      autogroup: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      pid: ProgramPidSchema,
      bootId: z.null(),
      autogroup: z.null(),
    })
    .strict(),
]);

export type ProgramRecord = z.infer<typeof ProgramRecordSchema>;

const CAPTURE_BUDGET_MS = 250;

interface ProcStat {
  readonly pid: number;
  readonly state: string;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly startTicks: string;
}

export function parseProcStat(text: string): ProcStat {
  // The command name can hold spaces and parentheses, so count the fields
  // from the last ')'.
  const open = text.indexOf(' (');
  const close = text.lastIndexOf(')');
  invariant(
    open > 0 && close > open,
    'proc stat must hold the command name in parentheses',
  );
  const fields = text.slice(close + 2).split(' ');
  const stat = {
    pid: Number(text.slice(0, open)),
    state: fields[0] ?? '',
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    startTicks: fields[19] ?? '',
  };
  invariant(
    [stat.pid, stat.ppid, stat.pgid, stat.sid].every(Number.isInteger) &&
      stat.state.length === 1 &&
      /^\d+$/.test(stat.startTicks),
    'proc stat fields must parse',
  );
  return stat;
}

// An empty file means the process is in no autogroup.
export function parseAutogroup(text: string): number | null {
  const match = /^\/autogroup-(\d+) nice -?\d+\n?$/.exec(text);
  return match === null ? null : Number(match[1]);
}

// null: the file is gone, as for a process that has exited.
function readProcFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH')) {
      return null;
    }
    throw error;
  }
}

function readProcStat(pid: number): ProcStat | null {
  const text = readProcFile(`/proc/${String(pid)}/stat`);
  return text === null ? null : parseProcStat(text);
}

function readAutogroup(pid: number): number | null {
  const text = readProcFile(`/proc/${String(pid)}/autogroup`);
  return text === null ? null : parseAutogroup(text);
}

function readBootId(): string | null {
  const bootId = readProcFile('/proc/sys/kernel/random/boot_id')?.trim();
  return bootId === undefined || bootId.length === 0 ? null : bootId;
}

function captureToken(
  pid: number,
): { bootId: string; autogroup: number } | null {
  if (process.platform !== 'linux') {
    return null;
  }
  const ownAutogroupFile = readProcFile('/proc/self/autogroup');
  const bootId = readBootId();
  if (ownAutogroupFile === null || bootId === null) {
    return null;
  }

  // node-pty returns before the child calls setsid(), so the first reads can
  // show the host's own session.
  const ownAutogroup = parseAutogroup(ownAutogroupFile);
  const deadline = Date.now() + CAPTURE_BUDGET_MS;
  while (Date.now() < deadline) {
    const before = readProcStat(pid);
    const autogroup = readAutogroup(pid);
    const after = readProcStat(pid);
    if (
      before === null ||
      after === null ||
      before.startTicks !== after.startTicks ||
      after.ppid !== process.pid
    ) {
      return null;
    }
    if (after.sid === pid && autogroup !== null && autogroup !== ownAutogroup) {
      return { bootId, autogroup };
    }
  }
  return null;
}

// For the host, right after it spawns the program and before it awaits
// anything, while the program is still its unreaped child.
export function captureProgram(pid: number): ProgramRecord {
  const token = captureToken(pid);
  return token === null
    ? { version: 1, pid, bootId: null, autogroup: null }
    : { version: 1, pid, ...token };
}

function validateProgramRecord(path: string, data: unknown): ProgramRecord {
  const parsed = ProgramRecordSchema.safeParse(data);
  if (parsed.success) {
    return parsed.data;
  }

  throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
    message: `Program record validation failed for ${path}.`,
    details: { path, issues: parsed.error.issues },
  });
}

// The host writes the record once, before its first manifest write.
export function writeProgramRecord(
  sessionDirectory: string,
  record: ProgramRecord,
): void {
  const path = programRecordPath(sessionDirectory);
  writeValidatedJsonFileSync({
    path,
    pathLabel: 'program record path',
    data: record,
    writeErrorMessage: `Failed to write the program record at ${path}.`,
    validate: validateProgramRecord,
  });
}
