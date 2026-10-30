import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const ProgramPidSchema = z.number().int().gt(1);
// On Linux, setsid() gives the new session a new autogroup, whose id comes
// from a counter that never repeats within a boot, and fork() passes it on.
// So the boot id and the autogroup id name the program's session, also after
// the program exits. A later group that reuses its id has another autogroup.
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

interface ChildPidGroup {
  readonly childPid: number;
  readonly sessionDirectory: string;
}

export type ProgramGroup = ProgramRecord | ChildPidGroup;

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

export interface ProcessRow {
  readonly pid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly state: string;
  readonly autogroup: number | null;
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

// The kernel prints nothing for a task in no autogroup.
export function parseAutogroup(text: string): number | null {
  const match = /^\/autogroup-(\d+) nice -?\d+\n?$/.exec(text);
  return match === null ? null : Number(match[1]);
}

function readProcFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH')) {
      return null;
    }
    throw error;
  }
}

function readLiveThreadState(pid: number): string | null {
  const taskDirectory = `/proc/${String(pid)}/task`;
  let tids: string[];
  try {
    tids = readdirSync(taskDirectory);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH')) {
      return null;
    }
    throw error;
  }
  for (const tid of tids) {
    const text = readProcFileIfExists(`${taskDirectory}/${tid}/stat`);
    const state = text === null ? 'X' : parseProcStat(text).state;
    if (state !== 'Z' && state !== 'X') {
      return state;
    }
  }
  return null;
}

// A process whose main thread called pthread_exit shows Z while another of
// its threads runs, so it takes the state of that thread.
function readProcStat(pid: number): ProcStat | null {
  const text = readProcFileIfExists(`/proc/${String(pid)}/stat`);
  if (text === null) {
    return null;
  }
  const stat = parseProcStat(text);
  const threadState = stat.state === 'Z' ? readLiveThreadState(pid) : null;
  return threadState === null ? stat : { ...stat, state: threadState };
}

// hidepid=1 (EPERM) or a security module (EACCES) refuses to show the
// process of another user.
function isRefusedRead(error: unknown): boolean {
  return hasErrorCode(error, 'EPERM') || hasErrorCode(error, 'EACCES');
}

// null also for a process that /proc refuses to show, which cannot carry
// the token in view.
function readShownProcStat(pid: number): ProcStat | null {
  try {
    return readProcStat(pid);
  } catch (error) {
    if (isRefusedRead(error)) {
      return null;
    }
    throw error;
  }
}

function readAutogroup(pid: number | 'self'): number | null {
  try {
    return parseAutogroup(
      readFileSync(`/proc/${String(pid)}/autogroup`, 'utf8'),
    );
  } catch {
    return null;
  }
}

// A hardened /proc can refuse the boot id and still show the autogroups.
function readBootId(): string | null {
  try {
    const bootId = readProcFileIfExists(
      '/proc/sys/kernel/random/boot_id',
    )?.trim();
    return bootId === undefined || bootId.length === 0 ? null : bootId;
  } catch (error) {
    if (isRefusedRead(error)) {
      return null;
    }
    throw error;
  }
}

function captureToken(
  pid: number,
): { bootId: string; autogroup: number } | null {
  if (process.platform !== 'linux') {
    return null;
  }
  const ownAutogroup = readAutogroup('self');
  const bootId = readBootId();
  if (ownAutogroup === null || bootId === null) {
    return null;
  }

  // node-pty returns before the child calls setsid(), so the first reads can
  // show the host's own session.
  const deadline = Date.now() + CAPTURE_BUDGET_MS;
  while (Date.now() < deadline) {
    const before = readShownProcStat(pid);
    const autogroup = readAutogroup(pid);
    const after = readShownProcStat(pid);
    if (
      before === null ||
      after === null ||
      before.startTicks !== after.startTicks ||
      after.ppid !== process.pid
    ) {
      return null;
    }
    if (after.sid === pid && autogroup !== ownAutogroup) {
      return autogroup === null ? null : { bootId, autogroup };
    }
  }
  return null;
}

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

function hasToken(record: ProgramRecord): record is ProvenRecord {
  return record.bootId !== null;
}

async function readProgramRecord(
  sessionDirectory: string,
): Promise<ProgramRecord | 'missing' | 'invalid'> {
  const path = programRecordPath(sessionDirectory);
  try {
    const record = await readValidatedJsonFile({
      path,
      pathLabel: 'program record path',
      allowMissing: true,
      readErrorMessage: `Failed to read the program record at ${path}.`,
      invalidJsonMessage: `The program record contains invalid JSON at ${path}.`,
      validate: validateProgramRecord,
    });
    return record ?? 'missing';
  } catch (error) {
    if (hasErrorCode(error, ERROR_CODES.MANIFEST_VALIDATION_ERROR)) {
      return 'invalid';
    }
    throw error;
  }
}

export async function readProvenProgramGroup(
  sessionDirectory: string,
): Promise<ProvenRecord | null> {
  const record = await readProgramRecord(sessionDirectory);
  return typeof record === 'object' && hasToken(record) ? record : null;
}

export async function readProgramGroup(
  sessionDirectory: string,
  childPid: number | null,
): Promise<ProgramGroup | null> {
  const record = await readProgramRecord(sessionDirectory);
  if (typeof record === 'object' && hasToken(record)) {
    return record;
  }
  if (record === 'invalid' || childPid === null) {
    return null;
  }
  return { childPid, sessionDirectory };
}

// unknown: /proc refuses the boot id, or shows a member of the program's
// session without an autogroup, so the group can still be ours.
type GroupJudgement =
  | { readonly verdict: 'owned'; readonly witness: number }
  | { readonly verdict: 'gone' | 'unproven' | 'unknown' };

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
  if (bootId === null) {
    return { verdict: 'unknown' };
  }
  if (bootId !== record.bootId) {
    return { verdict: 'unproven' };
  }
  const witness = members.find(
    (row) => row.sid === record.pid && row.autogroup === record.autogroup,
  );
  if (witness !== undefined) {
    return { verdict: 'owned', witness: witness.pid };
  }
  return members.some((row) => row.sid === record.pid && row.autogroup === null)
    ? { verdict: 'unknown' }
    : { verdict: 'unproven' };
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
  const stat = readShownProcStat(pid);
  return stat === null ? null : toProcessRow(stat);
}

function readGroupMembers(pgid: number): ProcessRow[] {
  const members: ProcessRow[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const stat = readShownProcStat(Number(entry));
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
      if (isRefusedRead(error)) {
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

export function isProgramGroupAlive(group: ProgramGroup | null): boolean {
  if (group === null) {
    return false;
  }
  if ('childPid' in group) {
    return (
      existsSync(group.sessionDirectory) && isProcessGroupAlive(group.childPid)
    );
  }
  if (!hasToken(group)) {
    return isProcessGroupAlive(group.pid);
  }
  const { verdict } = judgeLiveGroup(group);
  // A live member in view decides, because the members of a group share one
  // session. A group that can be ours reads alive, so a wait times out
  // instead of reporting it gone. With none in view, a zombie does not show
  // the group gone, and /proc can refuse or hide a live member of another
  // user, so the probe of a group without a token decides.
  return (
    verdict === 'owned' ||
    verdict === 'unknown' ||
    (verdict === 'gone' && isProcessGroupAlive(group.pid))
  );
}

export function stopProgramGroup(group: ProgramGroup | null): void {
  if (group === null) {
    return;
  }
  if ('childPid' in group) {
    if (existsSync(group.sessionDirectory)) {
      killProcessGroupBestEffort(group.childPid);
    }
    return;
  }
  if (!hasToken(group)) {
    killProcessGroupBestEffort(group.pid);
    return;
  }

  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    const judgement = judgeLiveGroup(group);
    if (judgement.verdict !== 'owned') {
      return;
    }
    // No pidfd exists for a process group, so the kill races a reused group
    // id. Reading the witness again shrinks that race to the time between
    // this read and the kill.
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
