#!/usr/bin/env node
/**
 * One-time helper: given a bundle root and a list of artifact paths (relative
 * to the bundle root), compute sha256 + bytes for each and emit a JSON object
 * with the `artifacts: [...]` block ready to paste into a canonical
 * manifest.json.
 *
 * Usage:
 *   node ./scripts/seed-canonical-manifest.mjs <bundle-dir> < artifact-list.txt
 * Where each line of stdin is `<relative-path>\t<description>`.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

async function hashFile(filePath) {
  const hash = createHash('sha256');
  return await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolvePromise(hash.digest('hex'));
    });
    stream.on('error', (error) => {
      stream.destroy();
      rejectPromise(error);
    });
  });
}

async function main() {
  const bundleDir = process.argv[2];
  if (bundleDir === undefined) {
    process.stderr.write(
      'Usage: node ./scripts/seed-canonical-manifest.mjs <bundle-dir> < artifact-list.txt\n',
    );
    process.exit(1);
  }
  const root = resolve(bundleDir);

  const stdinText = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
    });
    process.stdin.on('end', () => {
      resolvePromise(buffer);
    });
    process.stdin.on('error', rejectPromise);
  });

  const artifacts = [];
  for (const rawLine of stdinText.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) {
      process.stderr.write(`skipping malformed line: ${line}\n`);
      continue;
    }
    const path = line.slice(0, tabIndex).trim();
    const description = line.slice(tabIndex + 1).trim();
    const filePath = join(root, path);
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      process.stderr.write(`not a regular file: ${path}\n`);
      process.exit(1);
    }
    const sha256 = await hashFile(filePath);
    artifacts.push({
      path,
      description,
      sha256,
      bytes: stats.size,
    });
  }

  process.stdout.write(`${JSON.stringify({ artifacts }, null, 2)}\n`);
}

await main();
