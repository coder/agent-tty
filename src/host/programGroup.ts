import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { z } from 'zod';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  readValidatedJsonFile,
  writeValidatedJsonFileSync,
} from '../storage/manifests.js';
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
type ProvenRecord = Extract<ProgramRecord, { bootId: string }>;

const CAPTURE_BUDGET_MS = 250;
const STOP_ATTEMPTS = 5;

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

export interface ProcessRow {
  readonly pid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly state: string;
  readonly autogroup: number | null;
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
    createParentFolders: false,
  });
}

// The group that a kill may target. A record with a token names it. Without
// one, the kill trusts childPid, as before program.json existed, and a null
// childPid trusts no number.
export async function readProgramGroup(
  sessionDirectory: string,
  childPid: number | null,
): Promise<ProgramRecord | null> {
  const path = programRecordPath(sessionDirectory);
  const record = await readValidatedJsonFile({
    path,
    pathLabel: 'program record path',
    allowMissing: true,
    readErrorMessage: `Failed to read the program record at ${path}.`,
    invalidJsonMessage: `The program record contains invalid JSON at ${path}.`,
    validate: validateProgramRecord,
  });
  if (record !== null && record.bootId !== null) {
    return record;
  }
  return childPid === null
    ? null
    : { version: 1, pid: childPid, bootId: null, autogroup: null };
}

export type GroupJudgement =
  | { readonly verdict: 'owned'; readonly witness: number }
  | { readonly verdict: 'gone' | 'unproven' };

// A live member of the group proves the group is the program's when it is
// in the program's session: its session id is the program's pid and it has
// the recorded autogroup of the same boot.
export function judgeProgramGroup(
  record: ProvenRecord,
  bootId: string | null,
  rows: readonly ProcessRow[],
): GroupJudgement {
  const members = rows.filter(
    (row) => row.pgid === record.pid && row.state !== 'Z' && row.state !== 'X',
  );
  if (members.length === 0) {
    return { verdict: 'gone' };
  }
  const witness =
    bootId === record.bootId
      ? members.find(
          (row) => row.sid === record.pid && row.autogroup === record.autogroup,
        )
      : undefined;
  return witness === undefined
    ? { verdict: 'unproven' }
    : { verdict: 'owned', witness: witness.pid };
}

function toProcessRow(stat: ProcStat): ProcessRow {
  return {
    pid: stat.pid,
    pgid: stat.pgid,
    sid: stat.sid,
    state: stat.state,
    autogroup: readAutogroup(stat.pid),
  };
}

function readProcessRow(pid: number): ProcessRow | null {
  const stat = readProcStat(pid);
  return stat === null ? null : toProcessRow(stat);
}

function readGroupMembers(pgid: number): ProcessRow[] {
  const members: ProcessRow[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const stat = readProcStat(Number(entry));
    if (stat?.pgid === pgid) {
      members.push(toProcessRow(stat));
    }
  }
  return members;
}

function judgeLiveGroup(record: ProvenRecord): GroupJudgement {
  return judgeProgramGroup(record, readBootId(), readGroupMembers(record.pid));
}

// node-pty starts the program as a session leader, so the program's pid is
// also the id of its process group, which the program cannot leave. Windows
// has no process groups, so there the kill reaches the program's pid only.
function processGroupTarget(pgid: number): number {
  // process.kill(-0) signals the caller's own group, process.kill(-1) every
  // process that the caller may signal.
  invariant(
    Number.isInteger(pgid) && pgid > 1,
    'process group id must be an integer above 1',
  );
  return process.platform === 'win32' ? pgid : -pgid;
}

// hidepid=2 and hidepid=4 (shown as invisible and ptraceable on newer
// kernels) leave processes of other users out of the /proc listing. The
// last /proc line is the mount on top. An unreadable mountinfo counts as
// hiding them.
function procHidesOtherUsers(): boolean {
  let mountinfo: string;
  try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return true;
  }
  let hides = false;
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (fields[4] === '/proc' && fields[separator + 1] === 'proc') {
      hides = /(^|,)hidepid=(2|4|invisible|ptraceable)(,|$)/.test(
        fields[separator + 3] ?? '',
      );
    }
  }
  return hides;
}

// Whether /proc shows a process of the group that is not a zombie, or a
// process that it refuses to show, or null when it shows none of the group.
// kill(-pgid, 0) finds a zombie until its parent reaps it, and an init that
// never reaps orphans, such as a container's PID 1 without an init, never
// does. Off Linux, and when /proc hides other users, there is no scan and
// the answer is true, so a zombie reads alive. launchd reaps orphans on
// macOS.
function groupHasLiveProcess(pgid: number): boolean | null {
  if (process.platform !== 'linux' || procHidesOtherUsers()) {
    return true;
  }

  let seen = false;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let stat: ProcStat | null;
    try {
      stat = readProcStat(Number(entry));
    } catch (error) {
      // hidepid=1 (EPERM) or a security module (EACCES) refuses to show
      // the process of another user.
      if (hasErrorCode(error, 'EPERM') || hasErrorCode(error, 'EACCES')) {
        return true;
      }
      throw error;
    }
    if (stat?.pgid !== pgid) {
      continue;
    }
    if (stat.state !== 'Z' && stat.state !== 'X') {
      return true;
    }
    seen = true;
  }
  return seen ? false : null;
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(processGroupTarget(pgid), 0);
  } catch (error) {
    // EPERM: the group still holds a process of another user, which hidepid
    // can hide from /proc.
    if (hasErrorCode(error, 'EPERM')) {
      return groupHasLiveProcess(pgid) ?? true;
    }
    if (hasErrorCode(error, 'ESRCH')) {
      return false;
    }

    throw error;
  }

  // None in view: the kill found processes that were reaped before the scan.
  return groupHasLiveProcess(pgid) ?? false;
}

function killProcessGroupBestEffort(pgid: number): void {
  try {
    process.kill(processGroupTarget(pgid), 'SIGKILL');
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH') || hasErrorCode(error, 'EPERM')) {
      return;
    }

    throw error;
  }
}

// True while the group holds a process that the kill would target.
export function isProgramGroupAlive(group: ProgramRecord | null): boolean {
  if (group === null) {
    return false;
  }
  if (group.bootId === null) {
    return isProcessGroupAlive(group.pid);
  }
  return judgeLiveGroup(group).verdict === 'owned';
}

// SIGKILLs the group when the record proves it is the program's, and never
// when the proof fails. A record without a token gets the kill of its number.
export function stopProgramGroup(group: ProgramRecord | null): void {
  if (group === null) {
    return;
  }
  if (group.bootId === null) {
    killProcessGroupBestEffort(group.pid);
    return;
  }

  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    const judgement = judgeLiveGroup(group);
    if (judgement.verdict !== 'owned') {
      return;
    }
    // The scan can take milliseconds, so read the witness again right before
    // the kill. Between this read and the kill, every member must exit and
    // another group must take the id for the kill to miss.
    const witness = readProcessRow(judgement.witness);
    if (
      witness !== null &&
      judgeProgramGroup(group, group.bootId, [witness]).verdict === 'owned'
    ) {
      killProcessGroupBestEffort(group.pid);
      return;
    }
  }
}
