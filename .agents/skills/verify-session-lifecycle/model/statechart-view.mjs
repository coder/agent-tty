// Plain-word labels for SessionLifecycle.tla, for the /statechart skill's
// view module. Each chart state has two regions: what is on disk, and what
// the host process is doing.
const reader = (from, to) =>
  from.pc.gc === to.pc.gc ? 'another command' : 'gc';
const reconciles = (from, to) => `${reader(from, to)} reconciles:`;

export const title = 'One agent-tty session while gc and another command run';

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
  } else if (['boot', 'open', 'pidwrite', 'sockdir'].includes(v.hpc)) {
    host = v.hex === 'wait' ? 'Host starting, program runs' : 'Host starting';
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
    case 'ProgramExits':
      return 'the program ends';
    case 'HostWritesExit':
      return 'the host writes "exited"';
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
      return `${reconciles(from, to)} writes "failed"`;
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
    case 'AllFinished':
      return null;
    default:
      return action;
  }
};
