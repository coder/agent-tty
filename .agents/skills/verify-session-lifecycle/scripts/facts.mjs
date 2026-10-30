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
    /^const hostAlive = isProcessAlive\(manifest\.hostPid\);$/,
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
  return {
    CreateRecordsHostPid:
      launch >= 0 && launch < write && pidInManifest && onlyThroughCallback,
  };
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
      /^await stopSessionProcesses\(\s*sessionId,\s*manifest\.hostPid,\s*await readProgramGroup\(/,
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
      /^await stopSessionProcesses\(\s*sessionId,\s*current\.hostPid,\s*group,/,
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
    indexOfStatement(stop, /^killProcessBestEffort\(hostPid\);$/) >= 0 &&
    indexOfStatement(stop, /^const stopped = await waitForProcessesToExit\(/) >=
      0 &&
    guardIndex(stop, '!stopped', ts.SyntaxKind.ThrowStatement) >= 0;
  const wait = requireDeclaration(
    'src/host/lifecycle.ts',
    'waitForProcessesToExit',
  );
  const waitsForProcessesOnly =
    calls(wait.body, 'isProcessAlive').length === 1 &&
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
// waits for it, and only then records destroyed.
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
      found.length === 2 &&
      found[0] ===
        'await stopSessionProcesses( sessionId, null, await readProvenProgramGroup(sessionDirectory), sessionDirectory, signal, );',
  };
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

// runHost captures the program's token right after setChildPid and writes
// program.json as the first statement of its last try, before
// `await persistManifest()`, and no statement between createPty and that try
// awaits. So the record is written in the synchronous block that spawns the
// program.
function programRecordFacts() {
  const body = requireDeclaration('src/host/hostMain.ts', 'runHost').body;
  const spawn = indexOfStatement(body, /= createPty\(/);
  const named = indexOfStatement(body, /^state\.setChildPid\(pty\.pid\);$/);
  const captured = indexOfStatement(
    body,
    /^const program = captureProgram\(pty\.pid\);$/,
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
// No other code calls the raw group kill or builds a group target.
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
    checkedKill =
      st[0] === 'const judgement = judgeLiveGroup(group);' &&
      /^if \(judgement\.verdict !== 'owned'\) \{ return; \}$/.test(
        st[1] ?? '',
      ) &&
      st[2] === 'const witness = readProcessRow(judgement.witness);' &&
      /^if \( witness !== null && judgeProgramGroup\(group, group\.bootId, \[witness\]\)\.verdict === 'owned' \) \{ killProcessGroupBestEffort\(group\.pid\); return; \}$/.test(
        st[3] ?? '',
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
      if (isCall(node, 'killProcessGroupBestEffort')) {
        rawKills += 1;
        stray ||= file !== module || ownerPath(node) !== 'stopProgramGroup';
      }
      if (isCall(node, 'processGroupTarget')) {
        targets += 1;
        stray ||=
          file !== module ||
          !['isProcessGroupAlive', 'killProcessGroupBestEffort'].includes(
            ownerPath(node),
          );
      }
    });
  }
  return {
    ProvesGroupOwnership:
      synchronous &&
      checkedKill &&
      judgesToken &&
      rawKills > 0 &&
      targets === 2 &&
      !stray,
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

// runDestroyCommand runs the same command detached, in a new session, before
// it destroys anything when cliRunsInsideProgramSession matches. On Linux
// that check compares the program's pid with the CLI's session id, the
// fourth field after the command name in /proc/self/stat. Before it reads
// the manifest, the check matches AGENT_TTY_SESSION_ID, and the copy does
// not get that variable, so it does not start a copy of its own.
function rerunFacts() {
  const destroyFile = 'src/cli/commands/destroy.ts';
  const run = requireDeclaration(destroyFile, 'runDestroyCommand').body;
  const check = run.statements.findIndex(
    (st) =>
      ts.isIfStatement(st) &&
      normalize(st.expression.getText()) ===
        'await cliRunsInsideProgramSession(options.sessionId)' &&
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
  const lifecycle = 'src/host/lifecycle.ts';
  const compares = requireDeclaration(
    lifecycle,
    'cliRunsInsideProgramSession',
  ).body.statements.some((st) => {
    if (!ts.isReturnStatement(st) || st.expression === undefined) {
      return false;
    }
    let expression = st.expression;
    while (ts.isParenthesizedExpression(expression)) {
      expression = expression.expression;
    }
    return (
      normalize(expression.getText()) ===
      "manifest.childPid === (process.platform === 'linux' ? ownLinuxSessionId() : ownProcessGroupId())"
    );
  });
  const readsSessionId =
    /const \{ sid \} = parseProcStat\(readFileSync\('\/proc\/self\/stat', 'utf8'\)\)/.test(
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
  const copyDropsId =
    spawns.length === 1 &&
    normalize(spawns[0].getText()).includes(
      'env: { ...process.env, AGENT_TTY_SESSION_ID: undefined }',
    );
  return {
    ReRunsInNewSession:
      check >= 0 && destroy > check && detached && compares && readsSessionId,
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
  ['src/cli/commands/destroy.ts', 'runDestroyCommand'],
  ['src/cli/commands/destroy.ts', 'rerunInNewSession'],
  ['src/cli/commands/gc.ts', 'gcSessions'],
  ['src/host/lifecycle.ts', 'allocateSession'],
  ['src/host/lifecycle.ts', 'launchHost'],
  ['src/host/lifecycle.ts', 'isProcessAlive'],
  ['src/host/lifecycle.ts', 'killProcessBestEffort'],
  ['src/host/lifecycle.ts', 'ownLinuxSessionId'],
  ['src/host/lifecycle.ts', 'ownProcessGroupId'],
  ['src/host/lifecycle.ts', 'cliRunsInsideProgramSession'],
  ['src/host/lifecycle.ts', 'readSessionManifestOrThrow'],
  ['src/host/lifecycle.ts', 'waitForTerminalManifest'],
  ['src/host/lifecycle.ts', 'waitForProcessesToExit'],
  ['src/host/lifecycle.ts', 'stopSessionProcesses'],
  ['src/host/lifecycle.ts', 'recordDestroyed'],
  ['src/host/lifecycle.ts', 'destroySession'],
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
  ['src/host/programGroup.ts', 'processGroupTarget'],
  ['src/host/programGroup.ts', 'procHidesOtherUsers'],
  ['src/host/programGroup.ts', 'groupHasLiveProcess'],
  ['src/host/programGroup.ts', 'isProcessGroupAlive'],
  ['src/host/programGroup.ts', 'killProcessGroupBestEffort'],
  ['src/host/programGroup.ts', 'isProgramGroupAlive'],
  ['src/host/programGroup.ts', 'stopProgramGroup'],
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
  ['src/protocol/sessionStatusPolicy.ts', 'SESSION_STATUS_POLICIES'],
];

const RUN_HOST_PARTS = [
  /= await waitForManifestFromCreate\(/,
  /^invariant\(\s*manifest\.hostPid === process\.pid/,
  /^const persistManifest = createSerialManifestWriter\(/,
  /= await EventLog\.open\(/,
  /= createPty\(/,
  /state\.setChildPid\(/,
  /^const program = captureProgram\(/,
  /^const hangUpProgram = /,
  /^const startIdlePolling = /,
  /^const initiateShutdown = /,
  /^const startShutdown = /,
  /^const handlePtyExit = /,
  /^pty\.onExit\(/,
  /^process\.on\('SIGTERM'/,
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
  ...manifestWriteFacts(),
  ...programGroupFacts(),
  ...deniedProbeFacts(),
  ...groupWaitFacts(),
  ...programRecordFacts(),
  ...ownershipFacts(),
  ...fallbackFacts(),
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
