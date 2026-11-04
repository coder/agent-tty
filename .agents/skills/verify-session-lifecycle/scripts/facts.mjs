#!/usr/bin/env node
// Reads the facts that the SessionLifecycle model depends on from the source.
//
//   node facts.mjs <repo root>
//
// Prints one JSON object:
//   constants     guard booleans and status sets for the TLC config
//   fingerprints  a hash of each covered function, comments and layout removed
//   callSites     every caller of the functions that write or remove a session
//
// A guard reads TRUE only when its exact condition is a direct statement of
// the function it guards, in the order the model assumes. Any other shape
// reads FALSE, and the model then treats the guard as absent.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repo = process.argv[2];
if (repo === undefined) {
  console.error('usage: facts.mjs <repo root>');
  process.exit(2);
}

const sources = new Map();
function source(file) {
  if (!sources.has(file)) {
    const text = readFileSync(join(repo, file), 'utf8');
    sources.set(
      file,
      ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
    );
  }
  return sources.get(file);
}

const printer = ts.createPrinter({ removeComments: true });
function canonical(node) {
  return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
}
function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}
function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// `name` is a function, `Class.method`, or a top-level variable.
function findDeclaration(file, name) {
  const [owner, member] = name.split('.');
  let found;
  walk(source(file), (node) => {
    if (found !== undefined) {
      return;
    }
    if (member === undefined) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === owner) {
        found = node;
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === owner &&
        ts.isSourceFile(node.parent.parent.parent)
      ) {
        found = node;
      }
    } else if (ts.isClassDeclaration(node) && node.name?.text === owner) {
      found = node.members.find(
        (m) => m.name !== undefined && m.name.getText() === member,
      );
    }
  });
  return found;
}

function requireDeclaration(file, name) {
  const node = findDeclaration(file, name);
  if (node === undefined) {
    throw new Error(`${file}: cannot find ${name}`);
  }
  return node;
}

// --- guards -------------------------------------------------------------

function returnsOrContinues(statement, kind) {
  let hit = false;
  walk(statement, (node) => {
    if (node.kind === kind) {
      hit = true;
    }
  });
  return hit;
}

// The index of the direct statement of `block` that is
// `if (<condition>) { ... <exit> ... }`, or -1.
function guardIndex(block, condition, exitKind) {
  return block.statements.findIndex(
    (s) =>
      ts.isIfStatement(s) &&
      normalize(s.expression.getText()) === condition &&
      returnsOrContinues(s.thenStatement, exitKind),
  );
}

function indexOfStatement(block, pattern) {
  return block.statements.findIndex((s) => pattern.test(s.getText()));
}

function reconcileFacts() {
  const body = requireDeclaration(
    'src/host/lifecycle.ts',
    'reconcileSession',
  ).body;
  const terminal = guardIndex(
    body,
    'manifest === null || isTerminalSessionStatus(manifest.status)',
    ts.SyntaxKind.ReturnStatement,
  );
  const aliveRead = indexOfStatement(
    body,
    /^const hostAlive = isHostAlive\(\s*await readSessionHost\(sessionDirectory, manifest\),?\s*\);$/,
  );
  const alive = guardIndex(
    body,
    'manifest.hostPid !== null && hostAlive',
    ts.SyntaxKind.ReturnStatement,
  );
  const write = indexOfStatement(body, /^(?:try \{\s*)?await writeManifest\(/);
  // The re-read after the host is found dead, its guard, and a reconciled
  // record built from that copy, all before the write. A later re-read with
  // its guard, the one after the group wait, may stand in for that copy.
  const rereadOf = (name) => {
    const read = body.statements.findIndex((s) =>
      new RegExp(
        `^const ${name} = await readManifestIfExists\\(manifestFile\\);$`,
      ).test(s.getText()),
    );
    const guard = guardIndex(
      body,
      `${name} === null || isTerminalSessionStatus(${name}.status)`,
      ts.SyntaxKind.ReturnStatement,
    );
    return read >= 0 && guard === read + 1 ? guard : -1;
  };
  const reread = rereadOf('current');
  const latest = rereadOf('latest');
  const source = latest > reread ? 'latest' : 'current';
  const fromSource = indexOfStatement(
    body,
    new RegExp(
      `^const reconciledManifest: SessionRecord = \\{\\s*\\.\\.\\.${source},`,
    ),
  );
  const switchOnSource = indexOfStatement(
    body,
    new RegExp(`^switch \\(${source}\\.status\\)`),
  );
  return {
    ReconcileSkipsTerminal: terminal >= 0 && terminal < write,
    ReconcileSkipsLiveHost:
      aliveRead >= 0 && aliveRead < alive && alive >= 0 && alive < write,
    ReconcileRereads:
      alive >= 0 &&
      alive < reread &&
      Math.max(reread, latest) < switchOnSource &&
      switchOnSource < fromSource &&
      fromSource < write,
  };
}

function isCall(node, name) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  return ts.isIdentifier(callee)
    ? callee.text === name
    : ts.isPropertyAccessExpression(callee) && callee.name.text === name;
}

function calls(root, name) {
  const found = [];
  walk(root, (node) => {
    if (isCall(node, name)) {
      found.push(node);
    }
  });
  return found;
}

// allocateSession launches the host before it writes the first manifest, and
// that manifest carries the launched pid. runCreateCommand launches the host
// only through that callback.
function createFacts() {
  const body = requireDeclaration(
    'src/host/lifecycle.ts',
    'allocateSession',
  ).body;
  const launch = indexOfStatement(
    body,
    /^const hostPid = launch\(sessionId\);$/,
  );
  const write = indexOfStatement(
    body,
    /^await writeManifest\(manifestPath\(sessionDirectory\)/,
  );
  let pidInManifest = false;
  if (write >= 0) {
    walk(body.statements[write], (node) => {
      if (
        ts.isShorthandPropertyAssignment(node) &&
        node.name.text === 'hostPid'
      ) {
        pidInManifest = true;
      }
    });
  }
  const create = requireDeclaration(
    'src/cli/commands/create.ts',
    'runCreateCommand',
  );
  const launches = calls(create.body, 'launchHost');
  const onlyThroughCallback =
    launches.length > 0 &&
    launches.every((call) => {
      for (let n = call.parent; n !== undefined; n = n.parent) {
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
          return (
            isCall(n.parent, 'allocateSession') && n.parent.arguments[1] === n
          );
        }
      }
      return false;
    });
  // Right after the launch, captureHost reads the new host and
  // writeHostRecord writes host.json, before the first manifest names it.
  const recordsHost =
    launch >= 0 &&
    write > launch + 2 &&
    normalize(body.statements[launch + 1].getText()) ===
      'const hostRecord = captureHost(hostPid);' &&
    normalize(body.statements[launch + 2].getText()) ===
      'if (hostRecord !== null) { writeHostRecord(sessionDirectory, hostRecord); }';
  return {
    CreateRecordsHostPid:
      launch >= 0 && launch < write && pidInManifest && onlyThroughCallback,
    CreateRecordsHost: recordsHost,
    CreateStopsOnGiveUp: stopsOnGiveUp(create.body),
    HostChecksCreateFailed: checksCreateFailed(create.body),
    HostPollsCreateFailed: pollsCreateFailed(),
    CreateRetriesMarker: retriesMarker(create.body),
  };
}

// In runCreateCommand, the readiness wait is the only statement of a try
// whose catch calls host.stop() and then rethrows, so every error of the
// readiness wait stops the host. Only a win32 create skips the stop while the
// manifest names no program, so on Linux and macOS, which the model covers,
// it always stops. launchHost's stop sends SIGTERM through the ChildProcess
// handle, and runHost registers its SIGTERM handler before it waits for the
// manifest, notes a SIGTERM until the spawn, and skips the spawn when a
// SIGTERM came first.
// The catch of the try whose only statement is the readiness wait, as
// normalized statements, or null when runCreateCommand has no such try.
function giveUpCatch(body) {
  for (const s of body.statements) {
    if (!ts.isTryStatement(s) || s.catchClause === undefined) {
      continue;
    }
    const tried = s.tryBlock.statements.map((t) => normalize(t.getText()));
    if (
      tried.length === 1 &&
      tried[0] ===
        'result = await waitForReadyHost(socketFile, sessionDirectory, sessionId);'
    ) {
      // The text-mode line that names the session changes no process or
      // file, so the facts skip it.
      return s.catchClause.block.statements
        .map((t) => normalize(t.getText()))
        .filter(
          (t) => !t.startsWith('if (!options.json) { writeHumanErrorLines('),
        );
    }
  }
  return null;
}

function stopsOnGiveUp(body) {
  const st = giveUpCatch(body) ?? [];
  // No statement before the stop leaves the catch.
  const stops =
    st.length >= 4 &&
    st[0].startsWith('invariant(host !== undefined,') &&
    st.slice(1, -2).every((t) => !/\b(return|throw|break)\b/.test(t)) &&
    st.at(-2) ===
      "if (process.platform !== 'win32' || manifest?.childPid != null) { host.stop(); }" &&
    st.at(-1) === 'throw withSessionId(error, sessionId);';
  const launch = normalize(
    requireDeclaration('src/host/lifecycle.ts', 'launchHost').getText(),
  );
  const run = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const handler = indexOfStatement(run, /^process\.on\('SIGTERM'/);
  const wait = indexOfStatement(run, /= await waitForManifestFromCreate\(/);
  const skip = indexOfStatement(
    run,
    /^if \(sigterm\.received\) \{\s*await eventLog\.close\(\);\s*return;\s*\}$/,
  );
  const spawn = indexOfStatement(run, /= createPty\(/);
  return (
    stops &&
    /stop: \(\) => \{ child\.kill\('SIGTERM'\); \}/.test(launch) &&
    handler >= 0 &&
    handler < wait &&
    wait < skip &&
    skip === spawn - 1
  );
}

// The give-up catch writes the create-failed marker right before its manifest
// read, so the read comes after the marker. runHost checks for the marker right
// before its SIGTERM skip, before the spawn, and right after its start-up
// manifest write lands, before the listen, and then shuts down. So a host
// whose start-up write landed before create's read is named by that read,
// and a host whose write landed after it finds the marker.
function checksCreateFailed(body) {
  const st = giveUpCatch(body) ?? [];
  const marks =
    st.length >= 8 &&
    st[1] === 'const markerFile = createFailedMarkerPath(sessionDirectory);' &&
    st[2] === 'const manifestFile = manifestPath(sessionDirectory);' &&
    st[4] ===
      'let marked = await writeMarkerOrLog(markerFile, sessionId, logger);' &&
    st[5] ===
      'let manifest = await readManifestIfExists(manifestFile).catch(() => null);' &&
    writesMarker();
  const run = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const check = indexOfStatement(
    run,
    /^if \(existsSync\(createFailedMarkerPath\(sessDir\)\)\) \{\s*await eventLog\.close\(\);\s*return;\s*\}$/,
  );
  const skip = indexOfStatement(
    run,
    /^if \(sigterm\.received\) \{\s*await eventLog\.close\(\);\s*return;\s*\}$/,
  );
  const last = run.statements.at(-1);
  const tried =
    last !== undefined && ts.isTryStatement(last)
      ? last.tryBlock.statements.map((t) => normalize(t.getText()))
      : [];
  const write = tried.indexOf('await persistManifest();');
  const listen = tried.findIndex((t) =>
    t.startsWith('rpcListenPromise = listenInSocketDirectory('),
  );
  return (
    marks &&
    check >= 0 &&
    check === skip - 1 &&
    write >= 0 &&
    tried[write + 1] ===
      'if (existsSync(createFailedMarkerPath(sessDir))) { await initiateShutdown(); return; }' &&
    write + 1 < listen
  );
}

// writeMarkerOrLog writes the create-failed marker and reports whether the
// write landed.
function writesMarker() {
  const helper = normalize(
    requireDeclaration(
      'src/cli/commands/create.ts',
      'writeMarkerOrLog',
    ).body.getText(),
  );
  return helper.startsWith(
    '{ return writeCreateFailedMarker(path, sessionId).then( () => true, (error: unknown) => {',
  );
}

// On Windows, while the marker write fails and the manifest names no
// program, the give-up catch writes the marker again and reads the manifest
// after each write, a bounded number of times while the host runs, before
// its stop. So a host that the manifest does not name yet gets the marker,
// or the last read names its program and create stops it.
function retriesMarker(body) {
  const st = giveUpCatch(body) ?? [];
  const loop =
    'for ( let attempt = 1; ' +
    "process.platform === 'win32' && !marked && manifest?.childPid == null && " +
    'attempt <= MARKER_RETRY_MAX_ATTEMPTS && isProcessAlive(host.pid); ' +
    'attempt += 1 ) { ' +
    'await delay(MARKER_RETRY_INTERVAL_MS); ' +
    'marked = await writeMarkerOrLog(markerFile, sessionId, logger); ' +
    'manifest = await readManifestIfExists(manifestFile).catch(() => null); }';
  return st.length === 9 && st[6] === loop && checksCreateFailed(body);
}

// runHost's watchCreateFailed checks, every CREATE_FAILED_POLL_INTERVAL_MS,
// whether the creator still runs and then whether the create-failed marker
// exists. A probe that throws counts as an exited creator, so no error leaves
// the timer. On the marker it calls startShutdown, and it stops once a check
// after the creator's exit found none. The start-up try calls it right after
// the check that follows the start-up write.
function pollsCreateFailed() {
  const run = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const watch = indexOfStatement(run, /^const watchCreateFailed = /);
  const watches =
    watch >= 0 &&
    normalize(run.statements[watch].getText().replace(/\/\/[^\n]*/g, '')) ===
      'const watchCreateFailed = (): void => { const timer = setInterval(() => { let creatorGone = true; try { creatorGone = !isProcessAlive(creatorPid); } catch { } if (existsSync(createFailedMarkerPath(sessDir))) { clearInterval(timer); startShutdown(); } else if (creatorGone) { clearInterval(timer); } }, CREATE_FAILED_POLL_INTERVAL_MS); timer.unref(); };';
  const last = run.statements.at(-1);
  const tried =
    last !== undefined && ts.isTryStatement(last)
      ? last.tryBlock.statements.map((t) => normalize(t.getText()))
      : [];
  const check = tried.indexOf(
    'if (existsSync(createFailedMarkerPath(sessDir))) { await initiateShutdown(); return; }',
  );
  return watches && check >= 0 && tried[check + 1] === 'watchCreateFailed();';
}

// runHost waits for create's manifest, and every host write of session.json
// goes through one createSerialManifestWriter.
function hostFacts() {
  const runHost = requireDeclaration('src/host/hostMain.ts', 'runHost');
  const waits = indexOfStatement(
    runHost.body,
    /^const manifest = await waitForManifestFromCreate\(mPath, creatorPid\);$/,
  );
  const wait = requireDeclaration(
    'src/host/hostMain.ts',
    'waitForManifestFromCreate',
  );
  const loops = wait.body.statements.some(
    (s) =>
      ts.isWhileStatement(s) &&
      normalize(s.expression.getText()).startsWith('manifest === null') &&
      calls(s, 'readManifestIfExists').length > 0,
  );
  const writer = requireDeclaration(
    'src/host/manifestWriter.ts',
    'createSerialManifestWriter',
  );
  const chains =
    /tail\.then\(/.test(writer.getText()) &&
    /tail = next\.catch\(/.test(writer.getText());
  const stops =
    /if \(wroteTerminal\) \{\s*return;\s*\}\s*const record = snapshot\(\);\s*await write\(path, record\);\s*wroteTerminal = isTerminalSessionStatus\(record\.status\);/.test(
      writer.getText(),
    );
  return {
    HostWaitsForManifest: waits >= 0 && loops,
    HostSerializesWrites:
      calls(runHost.body, 'writeManifest').length === 0 &&
      calls(runHost.body, 'createSerialManifestWriter').length === 1 &&
      chains,
    HostStopsAfterTerminalWrite: stops,
    ShutdownChecksCommandable: shutdownChecksCommandable(runHost.body),
  };
}

function shutdownChecksCommandable(runHostBody) {
  const requests = calls(runHostBody, 'requestDestroy');
  if (requests.length !== 1) {
    return false;
  }
  let guard;
  let inShutdown = false;
  for (let n = requests[0].parent; n !== runHostBody; n = n.parent) {
    if (guard === undefined && ts.isIfStatement(n)) {
      guard = n;
    }
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText() === 'initiateShutdown'
    ) {
      inShutdown = true;
    }
  }
  if (
    guard === undefined ||
    normalize(guard.expression.getText()) !== 'isSessionCommandable(state)' ||
    !ts.isBlock(guard.thenStatement)
  ) {
    return false;
  }
  const block = guard.thenStatement;
  const request = indexOfStatement(block, /^state\.requestDestroy\(\);$/);
  const write = indexOfStatement(block, /^await persistManifest\(\);$/);
  return inShutdown && request >= 0 && request < write;
}

// destroy --force kills the host only when hostMatches proves it: on Linux
// judgeHost reads the recorded boot id and start time again, elsewhere ps
// shows `_host <session id>`. Liveness reads dead only on judgeHost's proof,
// and runHost records the host right after it read its manifest.
function hostProofFacts() {
  const lifecycle = 'src/host/lifecycle.ts';
  const kill = requireDeclaration(lifecycle, 'killHostBestEffort').body;
  const killsOnMatch =
    kill.statements.length === 1 &&
    ts.isIfStatement(kill.statements[0]) &&
    normalize(kill.statements[0].expression.getText()) ===
      'host !== null && hostMatches(host)' &&
    normalize(kill.statements[0].thenStatement.getText()) ===
      '{ killProcessBestEffort(host.pid); }';
  const matches = normalize(
    requireDeclaration(lifecycle, 'hostMatches').body.getText(),
  );
  const matchesOnProof = matches.includes(
    "process.platform === 'linux' ? judgeHost(host.pid, host.record) === 'alive' : psShowsSessionHost(host)",
  );
  const alive = normalize(
    requireDeclaration(lifecycle, 'isHostAlive').body.getText(),
  );
  const aliveUntilProof = alive.includes(
    "host !== null && judgeHost(host.pid, host.record) !== 'dead'",
  );
  const judge = normalize(
    requireDeclaration('src/host/hostRecord.ts', 'judgeHost').body.getText(),
  );
  const judgesIdentity = judge.includes(
    'record.bootId === bootId && record.startTicks === stat.startTicks',
  );
  const body = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const check = indexOfStatement(
    body,
    /^invariant\(\s*manifest\.hostPid === process\.pid/,
  );
  const records =
    check >= 0 &&
    normalize(body.statements[check + 1]?.getText() ?? '') ===
      'const hostRecord = captureHost(process.pid);' &&
    normalize(body.statements[check + 2]?.getText() ?? '') ===
      'if (hostRecord !== null) { writeHostRecord(sessDir, hostRecord); }';
  return {
    ProvesHostPid:
      killsOnMatch &&
      matchesOnProof &&
      aliveUntilProof &&
      judgesIdentity &&
      records,
  };
}

function repairFacts() {
  const lifecycle = 'src/host/lifecycle.ts';
  let marks = false;
  walk(requireDeclaration(lifecycle, 'recordDestroyed').body, (node) => {
    if (!ts.isIfStatement(node) || !ts.isBlock(node.thenStatement)) {
      return;
    }
    const st = node.thenStatement.statements.map((s) => normalize(s.getText()));
    marks ||=
      st.length === 2 &&
      st[0].startsWith(
        'await writeDestroyMarker( destroyMarkerPath(dirname(manifestFile)),',
      ) &&
      st[1].startsWith('await writeManifest(manifestFile, {') &&
      st[1].includes("status: 'destroyed'");
  });
  let repairs = false;
  walk(requireDeclaration(lifecycle, 'reconcileSession').body, (node) => {
    if (!ts.isTryStatement(node)) {
      return;
    }
    const [write, check] = node.tryBlock.statements;
    repairs ||=
      write !== undefined &&
      normalize(write.getText()) ===
        'await writeManifest(manifestFile, reconciledManifest);' &&
      check !== undefined &&
      ts.isIfStatement(check) &&
      normalize(check.expression.getText()) ===
        "reconciledStatus !== 'destroyed' && existsSync(destroyMarkerPath(sessionDirectory))" &&
      /^\{ await writeManifest\(manifestFile, \{[^]*status: 'destroyed'[^]*\}\); \}$/.test(
        normalize(check.thenStatement.getText()),
      );
  });
  // writeDestroyMarker writes through the helper that it shares with
  // writeCreateFailedMarker.
  const marker = normalize(
    requireDeclaration(
      'src/storage/manifests.ts',
      'writeDestroyMarker',
    ).body.getText(),
  );
  const emptyMarker = requireDeclaration(
    'src/storage/manifests.ts',
    'writeEmptyMarker',
  ).getText();
  const reconcile = requireDeclaration(lifecycle, 'reconcileSession').body;
  const marked = indexOfStatement(
    reconcile,
    /^if \(manifest !== null && isMarkedDestroyed\(sessionDirectory, manifest\)\) \{\s*if \(await writeMarkedDestroyed\(manifestFile, manifest\)\) \{\s*const socketFile = socketPath\(sessionDirectory\);\s*await unlinkIfPresent\(socketFile\);\s*await removeSocketDirectoryIfEmpty\(socketFile\);\s*await removeLegacySocketBestEffort\(socketFile\);\s*\}\s*return;\s*\}$/,
  );
  const markedCheck = normalize(
    requireDeclaration(lifecycle, 'isMarkedDestroyed').body.getText(),
  );
  const terminal = guardIndex(
    reconcile,
    'manifest === null || isTerminalSessionStatus(manifest.status)',
    ts.SyntaxKind.ReturnStatement,
  );
  const rewrite = normalize(
    requireDeclaration(lifecycle, 'writeMarkedDestroyed').body.getText(),
  );
  return {
    ReconcileRepairsDestroyed:
      marks &&
      repairs &&
      marker ===
        "{ await writeEmptyMarker(path, sessionId, 'destroy marker'); }" &&
      emptyMarker.includes("await replaceFileAtomic(path, '')") &&
      !emptyMarker.includes('mkdir'),
    ReconcileRepairsMarked:
      marked >= 0 &&
      marked < terminal &&
      markedCheck ===
        '{ return ( isTerminalSessionStatus(manifest.status) && !isDestroyedSessionStatus(manifest.status) && existsSync(destroyMarkerPath(sessionDirectory)) ); }' &&
      rewrite.includes(
        "await writeManifest(manifestFile, { ...rest, status: 'destroyed',",
      ),
  };
}

function destroyFacts() {
  const destroy = requireDeclaration('src/host/lifecycle.ts', 'destroySession');
  const returns = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node !== destroy) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(destroy);
  const stopsThenRecords = stopLeftoversThenRecordDestroyed(destroy);
  const recordsBeforeReturn =
    returns.length > 0 &&
    returns.every((r) => {
      if (!ts.isBlock(r.parent)) {
        return false;
      }
      const statements = r.parent.statements;
      const previous = statements[statements.indexOf(r) - 1]?.getText() ?? '';
      return (
        /^await recordDestroyed\(/.test(previous) ||
        (stopsThenRecords.records &&
          /^await stopLeftoversThenRecordDestroyed\(/.test(previous))
      );
    });
  const record = requireDeclaration('src/host/lifecycle.ts', 'recordDestroyed');
  const writes = calls(record.body, 'writeManifest');
  const write = writes.length === 1 ? writes[0] : undefined;
  const recordWrites =
    write !== undefined &&
    calls(record.body, 'unlinkIfPresent').length === 1 &&
    normalize(write.arguments[1]?.getText() ?? '').includes(
      "...manifest, status: 'destroyed'",
    );
  const literal = write?.arguments[1];
  const keepsExitCode =
    literal !== undefined &&
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.length === 3 &&
    ts.isSpreadAssignment(literal.properties[0]) &&
    literal.properties[0].expression.getText() === 'manifest' &&
    literal.properties
      .slice(1)
      .every(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ['status', 'updatedAt'].includes(p.name.getText()),
      );
  const force = destroy.body.statements.find(
    (st) =>
      ts.isIfStatement(st) &&
      normalize(st.expression.getText()) === 'force === true',
  );
  let forceRecords = false;
  if (force !== undefined && ts.isBlock(force.thenStatement)) {
    const block = force.thenStatement;
    const first = indexOfStatement(
      block,
      /^await stopSessionProcesses\(\s*sessionId,\s*await readSessionHost\(sessionDirectory, manifest\),\s*await readProgramGroup\(/,
    );
    const reread = indexOfStatement(
      block,
      /^const current = await readSessionManifestOrThrow\(/,
    );
    const group = indexOfStatement(
      block,
      /^const group = await readProgramGroup\(/,
    );
    const second = indexOfStatement(
      block,
      /^await stopSessionProcesses\(\s*sessionId,\s*await readSessionHost\(sessionDirectory, current\),\s*group,/,
    );
    const records = indexOfStatement(
      block,
      /^await recordDestroyed\(manifestFile, socketFile, current, group\);$/,
    );
    forceRecords =
      first >= 0 &&
      reread > first &&
      group > reread &&
      second > group &&
      records > second &&
      calls(block, 'reconcileSession').length === 0;
  }
  const stop = requireDeclaration(
    'src/host/lifecycle.ts',
    'stopSessionProcesses',
  ).body;
  const stopWaits =
    indexOfStatement(stop, /^stopProgramGroup\(group\);$/) >= 0 &&
    indexOfStatement(stop, /^killHostBestEffort\(host\);$/) >= 0 &&
    indexOfStatement(stop, /^const stopped = await waitForProcessesToExit\(/) >=
      0 &&
    guardIndex(stop, '!stopped', ts.SyntaxKind.ThrowStatement) >= 0;
  const wait = requireDeclaration(
    'src/host/lifecycle.ts',
    'waitForProcessesToExit',
  );
  const waitsForProcessesOnly =
    calls(wait.body, 'isHostAlive').length === 1 &&
    calls(wait.body, 'isProgramGroupAlive').length === 1 &&
    calls(wait.body, 'stat').length === 0 &&
    calls(wait.body, 'pathExists').length === 0;
  return {
    DestroyRecordsDestroyed:
      recordsBeforeReturn &&
      recordWrites &&
      forceRecords &&
      stopWaits &&
      waitsForProcessesOnly,
    DestroyKeepsExitCode: keepsExitCode,
    DestroyStopsLeftovers:
      stopsThenRecords.records &&
      stopsThenRecords.stops &&
      returns.every((r) => {
        const statements = ts.isBlock(r.parent) ? r.parent.statements : [];
        const previous = statements[statements.indexOf(r) - 1]?.getText() ?? '';
        return (
          /^await stopLeftoversThenRecordDestroyed\(/.test(previous) ||
          (ts.isBlock(r.parent) && r.parent === force?.thenStatement)
        );
      }),
  };
}

// The statements of destroySession's local stopLeftoversThenRecordDestroyed:
// with DestroyStopsLeftovers it stops the group that program.json proves,
// waits for it, and only then records destroyed. readProvenProgramGroup
// returns the record whenever it has a token, or the unshared group when
// this process cannot prove that it shares the host's pid space. A session
// that a process which saw the group recorded destroyed gets no wait for an
// unshared group (trustsDestroyed).
const UNSHARED_RETURN =
  'return (await sharesHostPids(sessionDirectory, false)) ? record : UNSHARED_GROUP;';
const STOP_UNLESS_TRUSTED =
  "await stopSessionProcesses( sessionId, null, terminal.status === 'destroyed' && group !== null && 'unshared' in group ? null : group, sessionDirectory, signal, );";
const STOP_ALWAYS =
  'await stopSessionProcesses( sessionId, null, group, sessionDirectory, signal, );';

function stopLeftoversThenRecordDestroyed(destroy) {
  let found = [];
  walk(destroy.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === 'stopLeftoversThenRecordDestroyed' &&
      node.initializer !== undefined &&
      ts.isArrowFunction(node.initializer) &&
      ts.isBlock(node.initializer.body)
    ) {
      found = node.initializer.body.statements.map((st) =>
        normalize(st.getText()),
      );
    }
  });
  return {
    records:
      found.length > 0 &&
      /^await recordDestroyed\(manifestFile, socketFile, terminal, null\);$/.test(
        found.at(-1),
      ),
    stops:
      found.length === 3 &&
      found[0] ===
        'const group = await readProvenProgramGroup(sessionDirectory);' &&
      [STOP_UNLESS_TRUSTED, STOP_ALWAYS].includes(found[1]) &&
      bodyIs(
        'readProvenProgramGroup',
        `const record = await readProgramRecord(sessionDirectory); if (typeof record !== 'object' || !hasToken(record)) { return null; } ${UNSHARED_RETURN}`,
      ) &&
      bodyIs('hasToken', 'return record.bootId !== null;'),
    trustsDestroyed: found[1] === STOP_UNLESS_TRUSTED,
  };
}

function bodyIs(name, text) {
  const body = requireDeclaration('src/host/programGroup.ts', name).body;
  return (
    normalize(body.statements.map((st) => st.getText()).join(' ')) === text
  );
}

function manifestWriteFacts() {
  const file = 'src/storage/manifests.ts';
  const visited = new Set();
  let renames = 0;
  let mkdirs = 0;
  const visit = (fn) => {
    walk(fn.body, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
        return;
      }
      const name = node.expression.text;
      if (name === 'rename') {
        renames += 1;
      }
      if (name === 'mkdir' || name === 'mkdirSync') {
        mkdirs += 1;
      }
      const local = findDeclaration(file, name);
      if (
        local !== undefined &&
        ts.isFunctionDeclaration(local) &&
        !visited.has(name)
      ) {
        visited.add(name);
        visit(local);
      }
    });
  };
  visit(requireDeclaration(file, 'writeManifest'));
  return { ManifestWriteNeedsFolder: renames > 0 && mkdirs === 0 };
}

// Every kill of the program that a rule depends on SIGKILLs its process
// group, and waitForProcessesToExit waits until the group is gone: the
// helpers signal the negated group id outside Windows, stopProgramGroup uses
// the kill, isProgramGroupAlive the probe, stopSessionProcesses and
// waitForProcessesToExit use those two, reconcileSession kills the group
// after its re-read, and handlePtyExit kills the group when the program ends
// during a destroy.
function programGroupFacts() {
  const module = 'src/host/programGroup.ts';
  const lifecycle = 'src/host/lifecycle.ts';
  const negates = requireDeclaration(
    module,
    'processGroupTarget',
  ).body.statements.some(
    (st) =>
      ts.isReturnStatement(st) &&
      normalize(st.expression?.getText() ?? '') ===
        "process.platform === 'win32' ? pgid : -pgid",
  );
  const signalsGroup = (name, signal) =>
    calls(requireDeclaration(module, name).body, 'kill').some(
      (call) =>
        normalize(call.getText()) ===
        `process.kill(processGroupTarget(pgid), ${signal})`,
    );
  const stopKills =
    calls(
      requireDeclaration(module, 'stopProgramGroup').body,
      'killProcessGroupBestEffort',
    ).length > 0;
  const aliveProbes =
    calls(
      requireDeclaration(module, 'isProgramGroupAlive').body,
      'isProcessGroupAlive',
    ).length > 0;
  const helpers =
    negates &&
    signalsGroup('killProcessGroupBestEffort', "'SIGKILL'") &&
    signalsGroup('isProcessGroupAlive', '0') &&
    stopKills &&
    aliveProbes;
  const stop = requireDeclaration(lifecycle, 'stopSessionProcesses').body;
  const forceKills =
    indexOfStatement(stop, /^stopProgramGroup\(group\);$/) >= 0;
  const probes = calls(
    requireDeclaration(lifecycle, 'waitForProcessesToExit').body,
    'isProgramGroupAlive',
  );
  const forceWaits =
    probes.length === 1 && probes[0].arguments[0]?.getText() === 'group';
  const reconcile = requireDeclaration(lifecycle, 'reconcileSession').body;
  const rereadGuard = guardIndex(
    reconcile,
    'current === null || isTerminalSessionStatus(current.status)',
    ts.SyntaxKind.ReturnStatement,
  );
  const reconcileKills =
    rereadGuard >= 0 &&
    indexOfStatement(reconcile, /^const group = await readProgramGroup\(/) ===
      rereadGuard + 1 &&
    indexOfStatement(reconcile, /^stopProgramGroup\(group\);$/) ===
      rereadGuard + 2;
  let exitKills = false;
  walk(requireDeclaration('src/host/hostMain.ts', 'runHost').body, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      node.name.getText() !== 'handlePtyExit'
    ) {
      return;
    }
    walk(node, (inner) => {
      if (
        ts.isIfStatement(inner) &&
        normalize(inner.expression.getText()) ===
          "currentStatus === 'destroying'" &&
        ts.isBlock(inner.thenStatement)
      ) {
        exitKills ||=
          indexOfStatement(
            inner.thenStatement,
            /^stopProgramGroup\(program\);$/,
          ) >= 0;
      }
    });
  });
  return {
    KillsProgramGroup:
      helpers && forceKills && forceWaits && reconcileKills && exitKills,
  };
}

// On EPERM, isProcessGroupAlive returns before it returns false on ESRCH,
// and reads the group alive when /proc shows none of it, so a group that
// holds only processes of another user reads alive also when hidepid hides
// them. groupHasLiveProcess, covered by its hash, reads a process in view
// alive unless it is a zombie, and a process that /proc refuses to show
// alive.
function deniedProbeFacts() {
  const body = requireDeclaration(
    'src/host/programGroup.ts',
    'isProcessGroupAlive',
  ).body;
  const handler = body.statements.find(ts.isTryStatement)?.catchClause?.block;
  if (handler === undefined) {
    return { ProbeCountsDeniedGroup: false };
  }
  const denied = indexOfStatement(
    handler,
    /^if \(hasErrorCode\(error, 'EPERM'\)\) \{\s*return groupHasLiveProcess\(pgid\) \?\? true;\s*\}$/,
  );
  const gone = indexOfStatement(
    handler,
    /^if \(hasErrorCode\(error, 'ESRCH'\)\) \{\s*return false;\s*\}$/,
  );
  return { ProbeCountsDeniedGroup: denied >= 0 && gone > denied };
}

// handlePtyExit records destroyed only after waitForProcessesToExit read the
// group gone, right before its exit write, and reconcileSession returns
// before its write while the group lives.
function groupWaitFacts() {
  let hostWaits = false;
  walk(requireDeclaration('src/host/hostMain.ts', 'runHost').body, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      node.name.getText() !== 'handlePtyExit'
    ) {
      return;
    }
    const records = calls(node, 'recordDestroyed');
    if (records.length !== 1) {
      return;
    }
    let guard = records[0].parent;
    while (guard !== node && !ts.isIfStatement(guard)) {
      guard = guard.parent;
    }
    if (!ts.isIfStatement(guard) || !ts.isBlock(guard.parent)) {
      return;
    }
    const statements = guard.parent.statements;
    const next = statements[statements.indexOf(guard) + 1];
    hostWaits =
      normalize(guard.expression.getText()) ===
        "currentStatus === 'destroying' && (await waitForProcessesToExit(null, program))" &&
      next !== undefined &&
      /^await persistManifest\(\);$/.test(next.getText());
  });
  const reconcile = requireDeclaration(
    'src/host/lifecycle.ts',
    'reconcileSession',
  ).body;
  const kill = indexOfStatement(reconcile, /^stopProgramGroup\(group\);$/);
  const wait = guardIndex(
    reconcile,
    '!(await waitForProcessesToExit(null, group))',
    ts.SyntaxKind.ReturnStatement,
  );
  const write = indexOfStatement(
    reconcile,
    /^(?:try \{\s*)?await writeManifest\(/,
  );
  return {
    HostWaitsForGroup: hostWaits,
    ReconcileWaitsForGroup: kill >= 0 && wait === kill + 1 && wait < write,
  };
}

function noAwaitIn(statements) {
  let found = false;
  const visit = (node) => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  statements.forEach(visit);
  return !found;
}

// runHost captures the program's token right after setChildPid, only when it
// wrote host.json, and writes
// program.json as the first statement of its last try, before
// `await persistManifest()`, and no statement between createPty and that try
// awaits. So the record is written in the synchronous block that spawns the
// program.
function programRecordFacts() {
  const body = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const spawn = indexOfStatement(body, /= createPty\(/);
  const named = indexOfStatement(body, /^state\.setChildPid\(pty\.pid\);$/);
  const captured = body.statements.findIndex(
    (s) =>
      normalize(s.getText()) ===
      'const program = hostRecord === null ? programWithoutToken(pty.pid) : captureProgram(pty.pid);',
  );
  const last = body.statements.at(-1);
  const tried =
    last !== undefined && ts.isTryStatement(last)
      ? last.tryBlock.statements.map((st) => st.getText())
      : [];
  return {
    RecordsProgramSync:
      spawn >= 0 &&
      named > spawn &&
      captured === named + 1 &&
      tried[0] === 'writeProgramRecord(sessDir, program);' &&
      tried[1] === 'await persistManifest();' &&
      noAwaitIn(body.statements.slice(spawn + 1, -1)),
  };
}

// Every group kill goes through stopProgramGroup. It is synchronous, and
// with a token it kills only right after it read a live member of the group
// again and found the program's session id, autogroup and boot id on it.
// No other code calls the raw group kill or builds a group target, and only
// stopProgramGroup sends the SIGSTOP and SIGCONT of signalProcessGroup.
function ownershipFacts() {
  const module = 'src/host/programGroup.ts';
  const stop = requireDeclaration(module, 'stopProgramGroup');
  const synchronous = !(stop.modifiers ?? []).some(
    (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
  );
  let checkedKill = false;
  walk(stop.body, (node) => {
    if (!ts.isForStatement(node) || !ts.isBlock(node.statement)) {
      return;
    }
    const st = node.statement.statements.map((s) => normalize(s.getText()));
    const owned = st.findIndex((s) =>
      /^if \(judgement\.verdict !== 'owned'\) \{ (return|break); \}$/.test(s),
    );
    checkedKill =
      st[0] === 'const judgement = judgeLiveGroup(group);' &&
      owned > 0 &&
      st[owned + 1] === 'const witness = readProcessRow(judgement.witness);' &&
      /^if \( witness !== null && judgeProgramGroup\(group, group\.bootId, \[witness\]\)\.verdict === 'owned' \) \{ killProcessGroupBestEffort\(group\.pid\); killed = true; return; \}$/.test(
        st[owned + 2] ?? '',
      );
  });
  const judge = normalize(
    requireDeclaration(module, 'judgeProgramGroup').getText(),
  );
  const judgesToken =
    judge.includes(
      "(row) => row.pgid === record.pid && row.state !== 'Z' && row.state !== 'X'",
    ) &&
    judge.includes(
      "if (bootId !== record.bootId) { return { verdict: 'unproven' }; }",
    ) &&
    judge.includes(
      '(row) => row.sid === record.pid && row.autogroup === record.autogroup',
    );
  let rawKills = 0;
  let targets = 0;
  let stray = false;
  for (const file of listSources('src')) {
    walk(source(file), (node) => {
      if (
        isCall(node, 'killProcessGroupBestEffort') ||
        isCall(node, 'signalProcessGroup')
      ) {
        rawKills += 1;
        stray ||= file !== module || ownerPath(node) !== 'stopProgramGroup';
      }
      if (isCall(node, 'processGroupTarget')) {
        targets += 1;
        stray ||=
          file !== module ||
          ![
            'isProcessGroupAlive',
            'killProcessGroupBestEffort',
            'signalProcessGroup',
          ].includes(ownerPath(node));
      }
    });
  }
  const signalParam = normalize(
    requireDeclaration(module, 'signalProcessGroup').parameters[1]?.getText() ??
      '',
  );
  return {
    ProvesGroupOwnership:
      synchronous &&
      checkedKill &&
      judgesToken &&
      rawKills > 0 &&
      targets === 3 &&
      signalParam === "signal: 'SIGSTOP' | 'SIGCONT'" &&
      !stray,
    FreezesUnseenGroup: freezeFacts(stop.body),
  };
}

// In stopProgramGroup's loop, each judgement of gone sends SIGSTOP to the
// group and judges again, so a member that a scan never shows stops and
// comes into view, while /proc names this process by its pid. The finally
// block sends a frozen group that got no kill SIGCONT, also when a scan
// throws.
function freezeFacts(body) {
  const guarded = body.statements.find(ts.isTryStatement);
  const loop = guarded?.tryBlock.statements.find(ts.isForStatement);
  if (
    guarded?.finallyBlock === undefined ||
    loop === undefined ||
    !ts.isBlock(loop.statement)
  ) {
    return false;
  }
  const st = loop.statement.statements.map((s) => normalize(s.getText()));
  const before = body.statements
    .slice(0, body.statements.indexOf(guarded))
    .map((s) => normalize(s.getText()));
  return (
    before.at(-2) === 'let frozen = false;' &&
    before.at(-1) === 'let killed = false;' &&
    guarded.tryBlock.statements.length === 1 &&
    st[1] ===
      "if (judgement.verdict === 'gone' && procShowsOwnPidSpace()) { frozen = signalProcessGroup(group.pid, 'SIGSTOP') || frozen; if (frozen) { continue; } }" &&
    normalize(
      requireDeclaration(
        'src/host/programGroup.ts',
        'procShowsOwnPidSpace',
      ).body.getText(),
    ) ===
      "{ try { return readlinkSync('/proc/self') === String(process.pid); } catch { return false; } }" &&
    normalize(guarded.finallyBlock.getText()) ===
      "{ if (frozen && !killed) { signalProcessGroup(group.pid, 'SIGCONT'); } }"
  );
}

// captureToken reads the program's autogroup between two reads of its stat,
// and keeps it only when the second read shows the program as the leader of
// its own session, with the same start time and the host as its parent, and
// the autogroup differs from the host's own. isProgramGroupAlive reads a
// group alive only while the check owns it, cannot run, or finds no live
// member while the probe reads the group alive, so a group whose members
// carry another autogroup reads gone.
function tokenFacts() {
  const module = 'src/host/programGroup.ts';
  const capture = requireDeclaration(module, 'captureToken').body;
  const loop = capture.statements.find(ts.isWhileStatement);
  const st =
    loop !== undefined && ts.isBlock(loop.statement)
      ? loop.statement.statements.map((s) => normalize(s.getText()))
      : [];
  const capturesOwnSession =
    capture.statements.some(
      (s) =>
        normalize(s.getText()) ===
        "const ownAutogroup = readAutogroup('self');",
    ) &&
    st[0] === 'const before = readShownProcStat(pid);' &&
    st[1] === 'const autogroup = readAutogroup(pid);' &&
    st[2] === 'const after = readShownProcStat(pid);' &&
    st[3] ===
      'if ( before === null || after === null || before.startTicks !== after.startTicks || after.ppid !== process.pid ) { return null; }' &&
    st[4] ===
      'if (after.sid === pid && autogroup !== ownAutogroup) { return autogroup === null ? null : { bootId, autogroup }; }';
  const alive = requireDeclaration(module, 'isProgramGroupAlive').body
    .statements;
  const readsUnprovenGone =
    normalize(alive.at(-2)?.getText() ?? '') ===
      'const { verdict } = judgeLiveGroup(group);' &&
    normalize(alive.at(-1)?.getText() ?? '') ===
      "return ( verdict === 'owned' || verdict === 'unknown' || (verdict === 'gone' && isProcessGroupAlive(group.pid)) );";
  return {
    TokenNamesProgram: capturesOwnSession,
    ReusedIdReadsGone: readsUnprovenGone,
  };
}

// A group that only a childPid names, without a record with a token, gets
// the kill and reads alive only while the session folder exists, checked in
// the same synchronous block as the kill or the probe.
function fallbackFacts() {
  const module = 'src/host/programGroup.ts';
  const first = (name) =>
    normalize(
      requireDeclaration(module, name).body.statements[1]?.getText() ?? '',
    );
  const read = requireDeclaration(module, 'readProgramGroup').body.statements;
  return {
    FallbackNeedsFolder:
      first('stopProgramGroup') ===
        "if ('childPid' in group) { if (existsSync(group.sessionDirectory)) { killProcessGroupBestEffort(group.childPid); } return; }" &&
      first('isProgramGroupAlive') ===
        "if ('childPid' in group) { return ( existsSync(group.sessionDirectory) && isProcessGroupAlive(group.childPid) ); }" &&
      normalize(read.at(-1)?.getText() ?? '') ===
        'return { childPid, sessionDirectory };',
  };
}

// A group with a token that this process cannot prove it shares the host's
// pid space with (sharesHostPids reads false: no /proc, an empty /proc,
// another pid namespace or another machine) is the unshared group:
// readProgramGroup and readProvenProgramGroup return it, it reads alive and
// it gets no kill. destroy trusts a destroyed record of such a session.
function unsharedFacts() {
  const module = 'src/host/programGroup.ts';
  const statement = (name, index) =>
    normalize(
      requireDeclaration(module, name).body.statements[index]?.getText() ?? '',
    );
  const shares = normalize(
    requireDeclaration(
      'src/host/hostRecord.ts',
      'sharesHostPids',
    ).body.getText(),
  );
  return {
    UnsharedGroupReadsUnknown:
      statement('readProgramGroup', 1) ===
        `if (typeof record === 'object' && hasToken(record)) { ${UNSHARED_RETURN} }` &&
      statement('readProvenProgramGroup', 2) === UNSHARED_RETURN &&
      statement('isProgramGroupAlive', 2) ===
        "if ('unshared' in group) { return true; }" &&
      statement('stopProgramGroup', 2) ===
        "if ('unshared' in group) { return; }" &&
      shares ===
        "{ if (process.platform !== 'linux') { return true; } const record = await readHostRecord(sessionDirectory); return record === null ? sharedWithoutRecord : inHostPidSpace(record); }" &&
      stopLeftoversThenRecordDestroyed(
        requireDeclaration('src/host/lifecycle.ts', 'destroySession'),
      ).trustsDestroyed,
  };
}

// runDestroyCommand runs the same command detached, in a new session, before
// it destroys anything when cliRunsInsideProgramSession matches. On Linux
// that check compares the program's pid with the CLI's session id, the
// fourth field after the command name in /proc/self/stat, and a CLI that
// cannot read that id, or reads 0, counts as inside. Before it reads
// the manifest, the check matches AGENT_TTY_SESSION_ID, and the copy does
// not get that variable. Off Linux the check compares the process group and
// the controlling terminal, which matches only when the CLI has one. The
// copy gets DESTROY_RERUN_ENV_KEY and skips the check, so it never starts a
// copy of its own.
function rerunFacts() {
  const destroyFile = 'src/cli/commands/destroy.ts';
  const run = requireDeclaration(destroyFile, 'runDestroyCommand').body;
  const check = run.statements.findIndex(
    (st) =>
      ts.isIfStatement(st) &&
      normalize(st.expression.getText()) ===
        "process.env[DESTROY_RERUN_ENV_KEY] !== '1' && (await cliRunsInsideProgramSession(options.sessionId))" &&
      /^\{\s*process\.exitCode = await rerunInNewSession\(\);\s*return;\s*\}$/.test(
        st.thenStatement.getText(),
      ),
  );
  const destroy = indexOfStatement(run, /^await destroySession\(/);
  const spawns = calls(
    requireDeclaration(destroyFile, 'rerunInNewSession').body,
    'spawn',
  );
  const detached =
    spawns.length === 1 && /\bdetached: true\b/.test(spawns[0].getText());
  const copyEnv =
    spawns.length === 1
      ? (/\benv: \{ \.\.\.process\.env, ([^}]*?),? \}/
          .exec(normalize(spawns[0].getText()))?.[1]
          .split(', ') ?? [])
      : [];
  const copySkipsCheck = copyEnv.includes("[DESTROY_RERUN_ENV_KEY]: '1'");
  const lifecycle = 'src/host/lifecycle.ts';
  const insideBody = requireDeclaration(
    lifecycle,
    'cliRunsInsideProgramSession',
  ).body;
  const insideStatements = insideBody.statements.map((st) =>
    normalize(st.getText()),
  );
  const linux = insideBody.statements.find(
    (st) =>
      ts.isIfStatement(st) &&
      normalize(st.expression.getText()) === "process.platform === 'linux'",
  );
  const linuxStatements =
    linux !== undefined && ts.isBlock(linux.thenStatement)
      ? linux.thenStatement.statements.map((st) => normalize(st.getText()))
      : [];
  const compares =
    linuxStatements.length === 2 &&
    linuxStatements[0] === 'const sid = ownLinuxSessionId();' &&
    linuxStatements[1] ===
      'return sid === null || manifest.childPid === sid;' &&
    insideStatements.at(-1) ===
      'return ( manifest.childPid === ownProcessGroupId() || sharesControllingTerminal(manifest.childPid) );' &&
    normalize(
      requireDeclaration(lifecycle, 'sharesControllingTerminal').body.getText(),
    ) ===
      '{ const own = controllingTerminal(process.pid); return own !== null && own === controllingTerminal(pid); }';
  const readsSessionId =
    /stat = readFileSync\('\/proc\/self\/stat', 'utf8'\);[^]*const \{ sid \} = parseProcStat\(stat\)/.test(
      normalize(requireDeclaration(lifecycle, 'ownLinuxSessionId').getText()),
    ) &&
    /const fields = text\.slice\(close \+ 2\)\.split\(' '\);[^]*sid: Number\(fields\[3\]\)/.test(
      requireDeclaration('src/host/programGroup.ts', 'parseProcStat').getText(),
    );
  const inside = requireDeclaration(
    lifecycle,
    'cliRunsInsideProgramSession',
  ).body;
  const readsEnv = inside.statements.findIndex(
    (st) =>
      ts.isIfStatement(st) &&
      normalize(st.expression.getText()) ===
        'process.env.AGENT_TTY_SESSION_ID === sessionId' &&
      /^\{\s*return true;\s*\}$/.test(st.thenStatement.getText()),
  );
  const readsManifest = indexOfStatement(
    inside,
    /= await readManifestIfExists\(/,
  );
  const copyDropsId = copyEnv.includes('AGENT_TTY_SESSION_ID: undefined');
  return {
    ReRunsInNewSession:
      check >= 0 &&
      destroy > check &&
      detached &&
      copySkipsCheck &&
      compares &&
      readsSessionId,
    InsideCheckReadsEnv:
      readsEnv >= 0 && readsEnv < readsManifest && copyDropsId,
  };
}

function gcFacts() {
  const fn = requireDeclaration('src/cli/commands/gc.ts', 'gcSessions');
  let loop;
  walk(fn.body, (node) => {
    if (loop === undefined && ts.isForOfStatement(node)) {
      loop = node.statement;
    }
  });
  if (loop === undefined || !ts.isBlock(loop)) {
    throw new Error('gcSessions: cannot find the loop over session entries');
  }
  const reconcile = indexOfStatement(loop, /dependencies\.reconcileSession\(/);
  const collectable = guardIndex(
    loop,
    '!isCollectableSessionStatus(manifestAfter.status)',
    ts.SyntaxKind.ContinueStatement,
  );
  const removal = loop.statements.find(
    (s) =>
      ts.isIfStatement(s) &&
      normalize(s.expression.getText()) === '!options.dryRun',
  );
  let finalCheck = false;
  if (removal !== undefined && ts.isBlock(removal.thenStatement)) {
    const inner = removal.thenStatement;
    const check = guardIndex(
      inner,
      'finalManifest !== null && !isCollectableSessionStatus(finalManifest.status)',
      ts.SyntaxKind.ContinueStatement,
    );
    const rm = indexOfStatement(inner, /dependencies\.rm\(sessionDirectory/);
    finalCheck = check >= 0 && rm > check;
  }
  return {
    GcSkipsNonCollectable: reconcile >= 0 && collectable > reconcile,
    GcFinalCheck: finalCheck,
  };
}

// Collectable and Terminal from the SESSION_STATUS_POLICIES table.
function policyFacts() {
  const decl = requireDeclaration(
    'src/protocol/sessionStatusPolicy.ts',
    'SESSION_STATUS_POLICIES',
  );
  let table = decl.initializer;
  while (!ts.isObjectLiteralExpression(table)) {
    table = table.expression;
  }
  const sets = { Collectable: [], Terminal: [] };
  for (const entry of table.properties) {
    const status = entry.name.getText();
    for (const field of entry.initializer.properties) {
      const value = field.initializer.kind === ts.SyntaxKind.TrueKeyword;
      const key = field.name.getText();
      if (value && key === 'collectable') {
        sets.Collectable.push(status);
      }
      if (value && key === 'terminal') {
        sets.Terminal.push(status);
      }
    }
  }
  sets.Collectable.sort();
  sets.Terminal.sort();
  return sets;
}

// --- coverage -----------------------------------------------------------

const COVERED = [
  ['src/cli/commands/create.ts', 'runCreateCommand'],
  ['src/cli/commands/create.ts', 'waitForReadyHost'],
  ['src/cli/commands/create.ts', 'writeMarkerOrLog'],
  ['src/cli/commands/destroy.ts', 'runDestroyCommand'],
  ['src/cli/commands/destroy.ts', 'rerunInNewSession'],
  ['src/cli/commands/gc.ts', 'gcSessions'],
  ['src/host/lifecycle.ts', 'allocateSession'],
  ['src/host/lifecycle.ts', 'launchHost'],
  ['src/host/lifecycle.ts', 'isProcessAlive'],
  ['src/host/lifecycle.ts', 'killProcessBestEffort'],
  ['src/host/lifecycle.ts', 'readSessionHost'],
  ['src/host/lifecycle.ts', 'psShowsSessionHost'],
  ['src/host/lifecycle.ts', 'isHostAlive'],
  ['src/host/lifecycle.ts', 'hostMatches'],
  ['src/host/lifecycle.ts', 'killHostBestEffort'],
  ['src/host/hostRecord.ts', 'captureHost'],
  ['src/host/hostRecord.ts', 'writeHostRecord'],
  ['src/host/hostRecord.ts', 'readHostRecord'],
  ['src/host/hostRecord.ts', 'pidExists'],
  ['src/host/hostRecord.ts', 'judgeHost'],
  ['src/host/hostRecord.ts', 'inPidNamespace'],
  ['src/host/hostRecord.ts', 'readTimeNamespace'],
  ['src/host/hostRecord.ts', 'inTimeNamespace'],
  ['src/host/hostRecord.ts', 'readMachineId'],
  ['src/host/hostRecord.ts', 'inHostPidSpace'],
  ['src/host/hostRecord.ts', 'sharesHostPids'],
  ['src/host/lifecycle.ts', 'ownLinuxSessionId'],
  ['src/host/lifecycle.ts', 'ownProcessGroupId'],
  ['src/host/lifecycle.ts', 'controllingTerminal'],
  ['src/host/lifecycle.ts', 'sharesControllingTerminal'],
  ['src/host/lifecycle.ts', 'cliRunsInsideProgramSession'],
  ['src/host/lifecycle.ts', 'readSessionManifestOrThrow'],
  ['src/host/lifecycle.ts', 'waitForTerminalManifest'],
  ['src/host/lifecycle.ts', 'waitForProcessesToExit'],
  ['src/host/lifecycle.ts', 'stopSessionProcesses'],
  ['src/host/lifecycle.ts', 'recordDestroyed'],
  ['src/host/lifecycle.ts', 'removeDeadHostSocket'],
  ['src/host/lifecycle.ts', 'destroySession'],
  ['src/host/lifecycle.ts', 'isMarkedDestroyed'],
  ['src/host/lifecycle.ts', 'writeMarkedDestroyed'],
  ['src/host/lifecycle.ts', 'reconcileSession'],
  ['src/host/hostMain.ts', 'waitForManifestFromCreate'],
  ['src/host/hostMain.ts', 'isSessionCommandable'],
  ['src/host/hostMain.ts', 'SHUTDOWN_KILL_GRACE_MS'],
  ['src/host/manifestWriter.ts', 'createSerialManifestWriter'],
  ['src/host/programGroup.ts', 'parseProcStat'],
  ['src/host/programGroup.ts', 'parseAutogroup'],
  ['src/host/programGroup.ts', 'readProcFileIfExists'],
  ['src/host/programGroup.ts', 'readLiveThreadState'],
  ['src/host/programGroup.ts', 'readProcStat'],
  ['src/host/programGroup.ts', 'isRefusedRead'],
  ['src/host/programGroup.ts', 'readShownProcStat'],
  ['src/host/programGroup.ts', 'readAutogroup'],
  ['src/host/programGroup.ts', 'readBootId'],
  ['src/host/programGroup.ts', 'captureToken'],
  ['src/host/programGroup.ts', 'captureProgram'],
  ['src/host/programGroup.ts', 'writeProgramRecord'],
  ['src/host/programGroup.ts', 'readProgramRecord'],
  ['src/host/programGroup.ts', 'readProvenProgramGroup'],
  ['src/host/programGroup.ts', 'readProgramGroup'],
  ['src/host/programGroup.ts', 'judgeProgramGroup'],
  ['src/host/programGroup.ts', 'readGroupMembers'],
  ['src/host/programGroup.ts', 'judgeLiveGroup'],
  ['src/host/programGroup.ts', 'processGroupTarget'],
  ['src/host/programGroup.ts', 'procHidesOtherUsers'],
  ['src/host/programGroup.ts', 'groupHasLiveProcess'],
  ['src/host/programGroup.ts', 'scanGroup'],
  ['src/host/programGroup.ts', 'isProcessGroupAlive'],
  ['src/host/programGroup.ts', 'killProcessGroupBestEffort'],
  ['src/host/programGroup.ts', 'signalProcessGroup'],
  ['src/host/programGroup.ts', 'isProgramGroupAlive'],
  ['src/host/programGroup.ts', 'stopProgramGroup'],
  ['src/host/programGroup.ts', 'procShowsOwnPidSpace'],
  ['src/host/rpcClient.ts', 'toTransportCliError'],
  ['src/host/sessionState.ts', 'SessionState.setDimensions'],
  ['src/host/sessionState.ts', 'SessionState.requestDestroy'],
  ['src/host/sessionState.ts', 'SessionState.recordDestroyed'],
  ['src/host/sessionState.ts', 'SessionState.recordExit'],
  ['src/host/eventLog.ts', 'EventLog.open'],
  ['src/host/rpcServer.ts', 'RpcServer.listen'],
  ['src/host/rpcServer.ts', 'RpcServer.close'],
  ['src/storage/manifests.ts', 'readValidatedJsonFile'],
  ['src/storage/manifests.ts', 'replaceFileAtomic'],
  ['src/storage/manifests.ts', 'replaceFileAtomicSync'],
  ['src/storage/manifests.ts', 'writeValidatedJsonFileSync'],
  ['src/storage/manifests.ts', 'writeManifest'],
  ['src/storage/manifests.ts', 'writeDestroyMarker'],
  ['src/storage/manifests.ts', 'writeCreateFailedMarker'],
  ['src/storage/manifests.ts', 'writeEmptyMarker'],
  ['src/protocol/sessionStatusPolicy.ts', 'SESSION_STATUS_POLICIES'],
];

const RUN_HOST_PARTS = [
  /= await waitForManifestFromCreate\(/,
  /^invariant\(\s*manifest\.hostPid === process\.pid/,
  /^const persistManifest = createSerialManifestWriter\(/,
  /= await EventLog\.open\(/,
  /= createPty\(/,
  /state\.setChildPid\(/,
  /^const program =/,
  /^const hangUpProgram = /,
  /^const startIdlePolling = /,
  /^const initiateShutdown = /,
  /^const startShutdown = /,
  /^const handlePtyExit = /,
  /^pty\.onExit\(/,
  /^process\.on\('SIGTERM'/,
  /^let onSigterm = /,
  /^if \(existsSync\(createFailedMarkerPath\(sessDir\)\)\) \{/,
  /^const watchCreateFailed = /,
  /^if \(sigterm\.received\) \{/,
  /^invariant\(!sigterm\.received/,
  /^onSigterm = startShutdown;/,
];

function runHostFingerprints() {
  const body = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const out = {};
  for (const pattern of RUN_HOST_PARTS) {
    const hits = body.statements.filter((s) => pattern.test(s.getText()));
    if (hits.length !== 1) {
      throw new Error(`runHost: ${hits.length} statements match ${pattern}`);
    }
  }
  const parts = body.statements.filter((s) =>
    RUN_HOST_PARTS.some((pattern) => pattern.test(s.getText())),
  );
  out['src/host/hostMain.ts#runHost(parts)'] = hash(
    parts.map(canonical).join('\n'),
  );
  const last = body.statements.at(-1);
  if (!ts.isTryStatement(last)) {
    throw new Error('runHost: the last statement is not the start-up try');
  }
  out['src/host/hostMain.ts#runHost(final try)'] = hash(canonical(last));
  for (const name of ['resize', 'destroy']) {
    let handler;
    walk(body, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === name &&
        ts.isVariableDeclaration(node.parent.parent) &&
        node.parent.parent.name.getText() === 'handlers'
      ) {
        handler = node;
      }
    });
    if (handler === undefined) {
      throw new Error(`runHost: cannot find the ${name} handler`);
    }
    out[`src/host/hostMain.ts#runHost>handlers.${name}`] = hash(
      canonical(handler),
    );
  }
  return out;
}

function fingerprints() {
  const out = {};
  for (const [file, name] of COVERED) {
    out[`${file}#${name}`] = hash(canonical(requireDeclaration(file, name)));
  }
  return { ...out, ...runHostFingerprints(), ...checkInputFingerprints() };
}

function listSources(dir) {
  const out = [];
  for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSources(path));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function ownerPath(node) {
  const names = [];
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isPropertyAssignment(n)) &&
      n.name !== undefined
    ) {
      names.unshift(n.name.getText());
    } else if (
      ts.isVariableDeclaration(n) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) ||
        ts.isFunctionExpression(n.initializer))
    ) {
      names.unshift(n.name.getText());
    }
  }
  return names.join('>') || '<module>';
}

// The model and the scripts that judge it are part of what a sync confirms,
// so a change to them without a new coverage.json shows as STALE too.
function checkInputFingerprints() {
  const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const out = {};
  for (const file of [
    'model/SessionLifecycle.tla',
    'scripts/facts.mjs',
    'scripts/check.sh',
  ]) {
    out[`skill:${file}`] = hash(readFileSync(join(skillDir, file), 'utf8'));
  }
  return out;
}

function hasRecursiveOption(call) {
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name.getText() === 'recursive' &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  );
}

// The helpers that write a manifest file (persistManifest is the host's serial
// writer), the function that names a session's manifest path, and reconcile.
// writeValidatedJsonFile and writeTextFileAtomic also write other files:
// listing their callers still shows a new writer of session.json that skips
// writeManifest, and a new caller of manifestPath shows a new writer that gets
// the path some other way.
const TRACKED_CALLS = [
  'writeManifest',
  'persistManifest',
  'replaceFileAtomic',
  'writeValidatedJsonFile',
  'writeTextFileAtomic',
  'manifestPath',
  'reconcileSession',
  'writeProgramRecord',
  'stopProgramGroup',
];

// Maps each local name of a tracked function in one file to the tracked name,
// so a call through an import alias (`import { writeManifest as save }`) counts.
function trackedNames(sourceFile) {
  const names = new Map(TRACKED_CALLS.map((name) => [name, name]));
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (TRACKED_CALLS.includes(imported)) {
        names.set(element.name.text, imported);
      }
    }
  }
  return names;
}

// Every call that writes a manifest, names a manifest path, reconciles, or
// removes a directory tree. A new one is code the model may have to cover:
// whatever its argument is named, a recursive rm can remove a session folder.
function callSites() {
  const out = {
    ...Object.fromEntries(TRACKED_CALLS.map((name) => [name, []])),
    recursiveRemovals: [],
  };
  for (const file of listSources('src')) {
    const sourceFile = source(relative(repo, join(repo, file)));
    const names = trackedNames(sourceFile);
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      const site = `${file}#${ownerPath(node)}`;
      const tracked = names.get(name);
      if (tracked !== undefined) {
        out[tracked].push(site);
      } else if (
        (name === 'rm' || name === 'rmSync') &&
        hasRecursiveOption(node)
      ) {
        out.recursiveRemovals.push(site);
      }
    });
  }
  for (const key of Object.keys(out)) {
    out[key].sort();
  }
  return out;
}

const constants = {
  ...reconcileFacts(),
  ...gcFacts(),
  ...createFacts(),
  ...hostFacts(),
  ...destroyFacts(),
  ...hostProofFacts(),
  ...repairFacts(),
  ...manifestWriteFacts(),
  ...programGroupFacts(),
  ...deniedProbeFacts(),
  ...groupWaitFacts(),
  ...programRecordFacts(),
  ...ownershipFacts(),
  ...fallbackFacts(),
  ...unsharedFacts(),
  ...tokenFacts(),
  ...rerunFacts(),
  ...policyFacts(),
};
console.log(
  JSON.stringify(
    { constants, fingerprints: fingerprints(), callSites: callSites() },
    null,
    2,
  ),
);
