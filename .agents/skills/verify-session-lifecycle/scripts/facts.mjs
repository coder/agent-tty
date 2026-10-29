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
import { join, relative } from 'node:path';
import process from 'node:process';

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
  return {
    ReconcileSkipsTerminal: terminal >= 0 && terminal < write,
    ReconcileSkipsLiveHost:
      aliveRead >= 0 && aliveRead < alive && alive >= 0 && alive < write,
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
  ['src/host/sessionState.ts', 'SessionState.setHostPid'],
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
  /= await readManifest\(/,
  /state\.setHostPid\(/,
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
  return { ...out, ...runHostFingerprints() };
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

// Every call that writes a manifest, reconciles, or removes a session
// directory. A new writer of session.json is new code the model must cover.
function callSites() {
  const out = { writeManifest: [], reconcileSession: [], removesSession: [] };
  for (const file of listSources('src')) {
    walk(source(relative(repo, join(repo, file))), (node) => {
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
      if (name === 'writeManifest' || name === 'reconcileSession') {
        out[name].push(site);
      } else if (
        name === 'rm' &&
        node.arguments.length > 0 &&
        /session/i.test(node.arguments[0].getText())
      ) {
        out.removesSession.push(site);
      }
    });
  }
  for (const key of Object.keys(out)) {
    out[key].sort();
  }
  return out;
}

const constants = { ...reconcileFacts(), ...gcFacts(), ...policyFacts() };
console.log(
  JSON.stringify(
    { constants, fingerprints: fingerprints(), callSites: callSites() },
    null,
    2,
  ),
);
