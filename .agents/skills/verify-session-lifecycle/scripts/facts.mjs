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
  const write = indexOfStatement(body, /^await writeManifest\(/);
  // The re-read after the host is found dead, its guard, and a reconciled
  // record built from that copy, all before the write.
  const reread = indexOfStatement(
    body,
    /^const current = await readManifestIfExists\(manifestFile\);$/,
  );
  const rereadGuard = guardIndex(
    body,
    'current === null || isTerminalSessionStatus(current.status)',
    ts.SyntaxKind.ReturnStatement,
  );
  const fromCurrent = indexOfStatement(
    body,
    /^const reconciledManifest: SessionRecord = \{\s*\.\.\.current,/,
  );
  const switchOnCurrent = indexOfStatement(body, /^switch \(current\.status\)/);
  return {
    ReconcileSkipsTerminal: terminal >= 0 && terminal < write,
    ReconcileSkipsLiveHost:
      aliveRead >= 0 && aliveRead < alive && alive >= 0 && alive < write,
    ReconcileRereads:
      alive >= 0 &&
      alive < reread &&
      rereadGuard === reread + 1 &&
      rereadGuard < switchOnCurrent &&
      switchOnCurrent < fromCurrent &&
      fromCurrent < write,
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
  return {
    HostWaitsForManifest: waits >= 0 && loops,
    HostSerializesWrites:
      calls(runHost.body, 'writeManifest').length === 0 &&
      calls(runHost.body, 'createSerialManifestWriter').length === 1 &&
      chains,
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
  ['src/cli/commands/gc.ts', 'gcSessions'],
  ['src/host/lifecycle.ts', 'allocateSession'],
  ['src/host/lifecycle.ts', 'launchHost'],
  ['src/host/lifecycle.ts', 'isProcessAlive'],
  ['src/host/lifecycle.ts', 'reconcileSession'],
  ['src/host/hostMain.ts', 'waitForManifestFromCreate'],
  ['src/host/manifestWriter.ts', 'createSerialManifestWriter'],
  ['src/host/sessionState.ts', 'SessionState.recordExit'],
  ['src/host/eventLog.ts', 'EventLog.open'],
  ['src/host/rpcServer.ts', 'RpcServer.listen'],
  ['src/host/rpcServer.ts', 'RpcServer.close'],
  ['src/storage/manifests.ts', 'readValidatedJsonFile'],
  ['src/storage/manifests.ts', 'writeTextFileAtomic'],
  ['src/storage/manifests.ts', 'writeManifest'],
  ['src/protocol/sessionStatusPolicy.ts', 'SESSION_STATUS_POLICIES'],
];

// The parts of runHost that the model describes, in source order: the
// start-up statements, handlePtyExit, initiateShutdown, pty.onExit, the
// resize handler, and the closing try block that writes and listens.
const RUN_HOST_PARTS = [
  /= await waitForManifestFromCreate\(/,
  /^invariant\(\s*manifest\.hostPid === process\.pid/,
  /^const persistManifest = createSerialManifestWriter\(/,
  /= await EventLog\.open\(/,
  /= createPty\(/,
  /state\.setChildPid\(/,
  /^const initiateShutdown = /,
  /^const handlePtyExit = /,
  /^pty\.onExit\(/,
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
  let resize;
  walk(body, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === 'resize' &&
      ts.isVariableDeclaration(node.parent.parent) &&
      node.parent.parent.name.getText() === 'handlers'
    ) {
      resize = node;
    }
  });
  if (resize === undefined) {
    throw new Error('runHost: cannot find the resize handler');
  }
  out['src/host/hostMain.ts#runHost>handlers.resize'] = hash(canonical(resize));
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
  'writeValidatedJsonFile',
  'writeTextFileAtomic',
  'manifestPath',
  'reconcileSession',
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
  ...policyFacts(),
};
console.log(
  JSON.stringify(
    { constants, fingerprints: fingerprints(), callSites: callSites() },
    null,
    2,
  ),
);
