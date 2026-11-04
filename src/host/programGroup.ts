import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import process from 'node:process';

import { z } from 'zod';

import { CliError } from '../cli/errors.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  readValidatedJsonFile,
  writeValidatedJsonFileSync,
} from '../storage/manifests.js';
import { programRecordPath } from '../storage/sessionPaths.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import { sharesHostPids } from './hostRecord.js';

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

// A group with a token in a pid space that this process cannot prove it
// shares with the host: without /proc, with an empty /proc, in another pid
// namespace or on another machine, or without host.json. No scan or probe here shows the
// program's processes, so the group reads alive and gets no kill.
interface UnsharedGroup {
  readonly unshared: true;
}

const UNSHARED_GROUP: UnsharedGroup = { unshared: true };

export type ProgramGroup = ProgramRecord | ChildPidGroup | UnsharedGroup;

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
export function readProcStat(pid: number): ProcStat | null {
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
export function readBootId(): string | null {
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

export function programWithoutToken(pid: number): ProgramRecord {
  return { version: 1, pid, bootId: null, autogroup: null };
}

export function captureProgram(pid: number): ProgramRecord {
  const token = captureToken(pid);
  return token === null
    ? programWithoutToken(pid)
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

// The errnos of a read that a retry does not change: the permissions or the
// file system refuse it (EACCES, EPERM, EIO), or a path names no readable
// file (EISDIR, ENOTDIR, ELOOP, ENAMETOOLONG). EMFILE, ENFILE, ENOMEM,
// EAGAIN and EINTR pass, so a later read can succeed.
const UNREADABLE_ERRNOS = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'EISDIR',
  'ENOTDIR',
  'ELOOP',
  'ENAMETOOLONG',
]);

// Whether a read of the program's group failed in a way that every later
// read repeats: a read of program.json (STORAGE_READ_ERROR) or of /proc,
// with one of UNREADABLE_ERRNOS. A verdict, HOST_TIMEOUT, an abort or a bug
// is none of these. A host.json that cannot be read counts as missing, so
// its group reads unshared and throws nothing here.
export function isUnreadableGroupError(error: unknown): boolean {
  const cause = hasErrorCode(error, ERROR_CODES.STORAGE_READ_ERROR)
    ? (error as Error).cause
    : error;
  const code: unknown =
    cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  return (
    !(cause instanceof CliError) &&
    typeof code === 'string' &&
    UNREADABLE_ERRNOS.has(code)
  );
}

// Whether destroy --force skips the program's group: the read of the group,
// or its first judgement, fails with an error that isUnreadableGroupError
// accepts.
export async function forceSkipsGroup(
  sessionDirectory: string,
  childPid: number | null,
): Promise<boolean> {
  try {
    isProgramGroupAlive(await readProgramGroup(sessionDirectory, childPid));
    return false;
  } catch (error) {
    return isUnreadableGroupError(error);
  }
}

export async function readProvenProgramGroup(
  sessionDirectory: string,
): Promise<ProvenRecord | UnsharedGroup | null> {
  const record = await readProgramRecord(sessionDirectory);
  if (typeof record !== 'object' || !hasToken(record)) {
    return null;
  }
  return (await sharesHostPids(sessionDirectory, false))
    ? record
    : UNSHARED_GROUP;
}

export async function readProgramGroup(
  sessionDirectory: string,
  childPid: number | null,
): Promise<ProgramGroup | null> {
  const record = await readProgramRecord(sessionDirectory);
  if (typeof record === 'object' && hasToken(record)) {
    return (await sharesHostPids(sessionDirectory, false))
      ? record
      : UNSHARED_GROUP;
  }
  if (
    record === 'invalid' ||
    childPid === null ||
    !(await sharesHostPids(sessionDirectory, true))
  ) {
    return null;
  }
  return { childPid, sessionDirectory };
}

// unknown: /proc refuses the boot id, or shows a member of the program's
// session without an autogroup, so the group can still be ours. running:
// such a member is not stopped, so it can have ended between its stat and
// its autogroup read, as a member of a fork chain does. A stopped one cannot
// end, so /proc refused its autogroup.
type GroupJudgement =
  | { readonly verdict: 'owned'; readonly witness: number }
  | { readonly verdict: 'unknown'; readonly running: boolean }
  | { readonly verdict: 'gone' | 'unproven' };

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
    return { verdict: 'unknown', running: false };
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
  const unread = members.filter(
    (row) => row.sid === record.pid && row.autogroup === null,
  );
  return unread.length > 0
    ? {
        verdict: 'unknown',
        running: unread.some((row) => row.state !== 'T' && row.state !== 't'),
      }
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

// Whether a scan shows a member of the group that job control or a tracer
// stopped.
function showsStoppedMember(pgid: number): boolean {
  return readGroupMembers(pgid).some(
    (row) => row.state === 'T' || row.state === 't',
  );
}

function readGroupMembers(pgid: number): ProcessRow[] {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch (error) {
    // A chroot or a container without a mounted /proc shows no member, so
    // the probe answers alone and nothing proves a kill.
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  const members: ProcessRow[] = [];
  for (const entry of entries) {
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
  const bootId = readBootId();
  const judgement = judgeProgramGroup(
    record,
    bootId,
    readGroupMembers(record.pid),
  );
  // A member can fork and end after the scan listed /proc, so a group that
  // reads gone is scanned once more.
  return judgement.verdict === 'gone'
    ? judgeProgramGroup(record, bootId, readGroupMembers(record.pid))
    : judgement;
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

  // A process of the group can fork and end after the scan listed /proc,
  // so a scan that finds no live process runs once more, and the group
  // shows only zombies when both scans show only zombies.
  const first = scanGroup(pgid);
  if (first === true) {
    return true;
  }
  const second = scanGroup(pgid);
  if (second === true) {
    return true;
  }
  return first === false && second === false ? false : null;
}

function scanGroup(pgid: number): boolean | null {
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

  // None in view: the kill found processes that were reaped before the scan,
  // or members of a fork chain that end before a scan reads them. A second
  // probe tells them apart: reaped processes are gone, a fork chain still
  // holds the id. Scans that show only zombies read the group ended.
  return groupHasLiveProcess(pgid) ?? probeFindsGroup(pgid);
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

// Whether the signal reached a process of the group. ESRCH: none is left.
// EPERM: only processes of another user are.
function signalProcessGroup(
  pgid: number,
  signal: 'SIGSTOP' | 'SIGCONT',
): boolean {
  try {
    process.kill(processGroupTarget(pgid), signal);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH') || hasErrorCode(error, 'EPERM')) {
      return false;
    }

    throw error;
  }
}

// /proc names this process by its own pid only when /proc belongs to this
// process's pid namespace. A /proc of another namespace, as after
// `unshare --pid --fork` without --mount-proc, shows none of this
// namespace's processes, and the group id can name this process's own group.
function procShowsOwnPidSpace(): boolean {
  try {
    return readlinkSync('/proc/self') === String(process.pid);
  } catch {
    return false;
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
  if ('unshared' in group) {
    return true;
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

// gc judges the group again at most this many times while a judgement
// stays inconclusive.
const GC_JUDGEMENTS = 10;

// Whether gc must keep the session. gc keeps it only while it proves that
// the group runs, so that destroy can end it. A group that gc cannot check,
// in another pid space or behind a refused read of /proc, proves nothing,
// and gc removes the session as it does one without a token. Else such a
// session would stay forever, for example after a container restart that
// keeps the home, when host.json names a pid namespace that no longer
// exists.
export async function provenProgramGroupRuns(
  sessionDirectory: string,
): Promise<boolean> {
  const group = await readProvenProgramGroup(sessionDirectory);
  if (group === null || 'unshared' in group) {
    return false;
  }
  for (let judged = 0; judged < GC_JUDGEMENTS; judged += 1) {
    const runs = judgeGroupForGc(group);
    if (runs !== null) {
      return runs;
    }
  }
  return false;
}

// true: a live member carries the token. false: the group ended, or the
// live members are not the program's. null: inconclusive. A member of a fork
// chain can end between its stat and its autogroup read (unknown), or show
// up only after the judge's scans. A refused read of /proc stays
// inconclusive.
function judgeGroupForGc(group: ProvenRecord): boolean | null {
  const { verdict } = judgeLiveGroup(group);
  if (verdict !== 'gone') {
    return verdict === 'owned' ? true : verdict === 'unproven' ? false : null;
  }
  // gc sends no SIGSTOP, so a fork chain that no scan shows reads gone: a
  // group id that the probe finds while no scan shows a member of the
  // group, not even a zombie, counts.
  if (!probeFindsGroup(group.pid)) {
    return false;
  }
  const live = groupHasLiveProcess(group.pid);
  return live === null ? true : live ? null : judgeFrozenGroup(group);
}

// A frozen judgement that reads gone is judged frozen once more, so a gc
// sends at most GC_JUDGEMENTS * FROZEN_JUDGEMENTS SIGSTOP and SIGCONT pairs.
const FROZEN_JUDGEMENTS = 2;

// The scans show only zombies of the group while the probe finds its id.
// Under a PID 1 that never reaps, the zombies of a fork chain stay, and its
// live member can escape both scans. SIGSTOP freezes the group, as in
// stopProgramGroup, and a stopped member stays in view. Another gc or a
// destroy can send SIGCONT before the judgement, so a frozen group that
// still reads gone gets another SIGSTOP and judgement. When that one reads
// gone too, the judgement stays inconclusive, and provenProgramGroupRuns
// judges the group again. So gc reads a live fork chain ended only when a
// SIGCONT from elsewhere came before each of its frozen judgements and the
// chain's live member escaped every scan. The group gets SIGCONT, also when
// a scan throws.
function judgeFrozenGroup(group: ProvenRecord): boolean | null {
  for (let frozen = 0; frozen < FROZEN_JUDGEMENTS; frozen += 1) {
    if (!procShowsOwnPidSpace() || !signalProcessGroup(group.pid, 'SIGSTOP')) {
      return false;
    }
    let verdict: GroupJudgement['verdict'];
    try {
      verdict = judgeLiveGroup(group).verdict;
    } finally {
      signalProcessGroup(group.pid, 'SIGCONT');
    }
    if (verdict !== 'gone') {
      return verdict === 'owned' ? true : verdict === 'unproven' ? false : null;
    }
  }
  return null;
}

function probeFindsGroup(pgid: number): boolean {
  try {
    process.kill(processGroupTarget(pgid), 0);
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
  if ('unshared' in group) {
    return;
  }
  if (!hasToken(group)) {
    killProcessGroupBestEffort(group.pid);
    return;
  }

  // A member that forks its successor and ends between scans is never in
  // view. One that a scan shows can also end between two reads: before its
  // autogroup read (unknown, running) or before the witness is read again.
  // SIGSTOP freezes the group, also a child that a member forks while the
  // kernel delivers it, and a stopped member stays in view and cannot end,
  // so a judgement that gets no kill and is neither unproven nor an unknown
  // without a running member sends SIGSTOP and judges the frozen group
  // again. Each such judgement sends SIGSTOP again, for a member that a
  // SIGCONT from elsewhere resumed. A frozen group that gets no kill gets
  // SIGCONT, also when a scan throws. So a group that shows a member that
  // job control stopped before the first freeze gets no SIGSTOP: the
  // SIGCONT would resume that member.
  let frozen = false;
  let killed = false;
  try {
    for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
      const judgement = judgeLiveGroup(group);
      if (
        judgement.verdict === 'unproven' ||
        (judgement.verdict === 'unknown' && !judgement.running)
      ) {
        return;
      }
      // No pidfd exists for a process group, so the kill races a reused
      // group id. Reading the witness again shrinks that race to the time
      // between this read and the kill.
      if (judgement.verdict === 'owned') {
        const witness = readProcessRow(judgement.witness);
        if (
          witness !== null &&
          judgeProgramGroup(group, group.bootId, [witness]).verdict === 'owned'
        ) {
          killProcessGroupBestEffort(group.pid);
          killed = true;
          return;
        }
      }
      if (!procShowsOwnPidSpace()) {
        return;
      }
      if (!frozen && showsStoppedMember(group.pid)) {
        return;
      }
      frozen = signalProcessGroup(group.pid, 'SIGSTOP') || frozen;
      if (!frozen) {
        return;
      }
    }
  } finally {
    if (frozen && !killed) {
      signalProcessGroup(group.pid, 'SIGCONT');
    }
  }
}
