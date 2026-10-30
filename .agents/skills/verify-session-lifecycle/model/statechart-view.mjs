// Plain-word labels for SessionLifecycle.tla, for the /statechart skill's
// view module. Each chart state has two regions: what is on disk, and what
// the host process is doing.
const reader = (from, to) =>
  from.pc.gc === to.pc.gc ? 'another command' : 'gc';
const reconciles = (from, to) => `${reader(from, to)} reconciles:`;

export const title =
  'One agent-tty session while gc, destroy and another command run';

export const state = (v) => {
  let files;
  if (!v.dir) {
    files = 'No session folder';
  } else if (v.mst === 'none') {
    files = 'Folder, no manifest yet';
  } else if (v.mst === 'failed') {
    files =
      v.morigin === 'host-death'
        ? 'Manifest: failed, host died'
        : 'Manifest: failed, unknown origin';
  } else {
    files = `Manifest: ${v.mst}${v.mpid ? '' : ', no host pid'}`;
  }

  let host;
  if (!v.hostAlive) {
    host = v.hpc === 'none' ? 'Host not started' : 'Host gone';
    host += v.prog ? ', program runs' : '';
  } else if (['boot', 'open', 'pidwrite', 'sockdir'].includes(v.hpc)) {
    host = v.hex === 'wait' ? 'Host starting, program runs' : 'Host starting';
  } else if (v.hex === 'wait' && v.hst === 'destroying') {
    host = 'Host shutting down, program runs';
  } else if (v.hex === 'wait') {
    host = v.sock ? 'Host serving' : 'Host serving, socket file gone';
  } else {
    host = 'Host finishing';
  }
  return { Files: files, Host: host };
};

export const step = (action, from, to) => {
  switch (action) {
    case 'CreateMakesDirectory':
      return 'create makes the session folder';
    case 'CreateWritesManifest':
      return to.mpid
        ? 'create writes "running" with the host pid'
        : 'create writes "running" without a host pid';
    case 'CreateLaunchesHost':
      return 'create starts the host';
    case 'HostReadsManifest':
      return to.hostAlive
        ? 'the host reads the manifest'
        : 'the host finds no running manifest and exits';
    case 'HostOpensLogAndSpawns':
      return to.hostAlive
        ? 'the host opens the event log and starts the program'
        : 'the host finds no folder and exits';
    case 'HostWritesPids':
      return 'the host start-up write lands: running, with pids';
    case 'HostListens':
      return 'the host listens on its socket';
    case 'HostStartsResize':
      return 'a resize starts a manifest write';
    case 'HostResizeWriteLands':
      return 'the resize write lands: running';
    case 'HostGetsSigterm':
      return 'the host gets SIGTERM';
    case 'HostWritesDestroying':
      return from.mst === to.mst && from.dir === to.dir
        ? 'the host skips its shutdown write'
        : `the host shutdown write lands: ${to.mst}`;
    case 'HostKillsProgram':
      return "the kill timer kills the program's process group";
    case 'ProgramExits':
      return to.prog
        ? 'the program ends, a process of its group still runs'
        : 'the program ends';
    case 'HostWritesExit':
      return from.mst === to.mst && from.dir === to.dir
        ? 'the host skips its exit write'
        : `the host writes "${to.mst}"`;
    case 'HostClosesSocket':
      return 'the host closes its socket';
    case 'HostProcessEnds':
      return 'the host process ends';
    case 'HostCrashes':
      return 'the host process dies';
    case 'ReconcileReads':
      return `${reconciles(from, to)} reads the manifest`;
    case 'ReconcileChecksHost':
      return `${reconciles(from, to)} checks the host pid`;
    case 'ReconcileRereadsManifest':
      return `${reconciles(from, to)} reads the manifest again`;
    case 'ReconcileWrites':
      return `${reconciles(from, to)} writes "${to.mst}"`;
    case 'ReconcileUnlinksSocket':
      return `${reconciles(from, to)} unlinks the socket file`;
    case 'GcFindsDirectory':
      return 'gc finds the session folder';
    case 'GcReadsManifest':
      return 'gc reads the manifest';
    case 'GcReadsReconciled':
      return 'gc reads the reconciled manifest';
    case 'GcFinalRead':
      return 'gc reads the manifest a last time';
    case 'GcRemoves':
      return 'gc removes the session folder';
    case 'ListStartsReconcile':
      return 'another command starts a reconcile';
    case 'DestroyReads':
      return to.dpc === 'done'
        ? 'destroy reads the manifest and fails'
        : 'destroy reads the manifest';
    case 'DestroyWritesDestroyed':
      return 'destroy writes "destroyed"';
    case 'DestroyUnlinksSocket':
      return 'destroy unlinks the socket file and succeeds';
    case 'DestroyKills':
      return "destroy --force kills the host and the program's group";
    case 'DestroyRereads':
      return 'destroy reads the manifest after the kill';
    case 'DestroySendsRpc':
      return 'the host takes the destroy request';
    case 'DestroyRpcFails':
      return 'destroy cannot reach the host';
    case 'DestroyPolls':
      return 'destroy polls the manifest';
    case 'DestroyFinalRead':
      return 'destroy reads the manifest after its reconcile';
    case 'AllFinished':
      return null;
    default:
      return action;
  }
};
