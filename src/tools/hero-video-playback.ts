import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  canonicalBundleArtifactEntry,
  readCanonicalBundleManifest,
  sha256File,
  writeCanonicalBundleManifest,
} from './canonicalBundleArtifacts.js';
import { invariant } from '../util/assert.js';
import { isDirectExecution } from '../util/isDirectExecution.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BUNDLE_DIR = join(REPO_ROOT, 'dogfood/agent-uses-agent-tty');
const DEFAULT_ROOT_README = join(REPO_ROOT, 'README.md');
const USER_ATTACHMENT_PREFIX = 'https://github.com/user-attachments/assets/';
const AGENTS = ['codex', 'claude'] as const;

type AgentName = (typeof AGENTS)[number];
type AgentUrls = Record<AgentName, string>;

const README_LINKS: Record<
  AgentName,
  {
    rootAlt: string;
    rootThumbnail: string;
    bundleAlt: string;
    bundleThumbnail: string;
  }
> = {
  codex: {
    rootAlt: 'Codex agent-tty demo',
    rootThumbnail:
      './dogfood/agent-uses-agent-tty/artifacts/codex-thumbnail.png',
    bundleAlt: 'Codex Hero Demo',
    bundleThumbnail: './artifacts/codex-thumbnail.png',
  },
  claude: {
    rootAlt: 'Claude agent-tty demo',
    rootThumbnail:
      './dogfood/agent-uses-agent-tty/artifacts/claude-thumbnail.png',
    bundleAlt: 'Claude Hero Demo',
    bundleThumbnail: './artifacts/claude-thumbnail.png',
  },
};

export interface PrepareHeroVideoUploadAssetsOptions {
  bundleDir?: string;
  uploadDir?: string;
}

export interface ApplyHeroVideoUrlsOptions {
  rootReadmePath?: string;
  bundleDir?: string;
  urls: AgentUrls;
}

function toolCommand(envName: string, fallback: string): string {
  return process.env[envName] ?? fallback;
}

function run(command: string, args: string[], cwd = REPO_ROOT): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function assertNonEmptyFile(path: string): Promise<void> {
  const stats = await stat(path);
  invariant(
    stats.isFile() && stats.size > 0,
    `expected non-empty file: ${path}`,
  );
}

function assertAttachmentUrl(url: string, agent: AgentName): void {
  invariant(
    url.startsWith(USER_ATTACHMENT_PREFIX),
    `${agent} URL must start with ${USER_ATTACHMENT_PREFIX}`,
  );
}

function replaceOne(
  text: string,
  pattern: RegExp,
  replacement: string,
): string {
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  const matches = text.match(globalPattern) ?? [];
  invariant(matches.length === 1, `expected one match for ${pattern}`);
  return text.replace(pattern, replacement);
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  invariant(
    value !== undefined && !value.startsWith('--'),
    `missing value for ${name}`,
  );
  args.splice(index, 2);
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateReadmeLink(
  text: string,
  alt: string,
  thumbnailPath: string,
  url: string,
): string {
  const pattern = new RegExp(
    `(\\[!\\[${escapeRegExp(alt)}\\]\\(${escapeRegExp(thumbnailPath)}\\)\\])\\([^)]*\\)`,
  );
  return replaceOne(text, pattern, `$1(${url})`);
}

async function updateManifest(
  bundleDir: string,
  paths: string[],
): Promise<void> {
  const manifestPath = resolve(bundleDir, 'manifest.json');
  const manifest = await readCanonicalBundleManifest(manifestPath);
  for (const path of paths) {
    const index = manifest.artifacts.findIndex(
      (artifact) => artifact.path === path,
    );
    invariant(index >= 0, `manifest entry not found: ${path}`);
    const current = manifest.artifacts[index];
    invariant(current !== undefined, `manifest entry not found: ${path}`);
    manifest.artifacts[index] = await canonicalBundleArtifactEntry(
      bundleDir,
      path,
      current.description,
    );
  }
  await writeCanonicalBundleManifest(manifestPath, manifest);
}

export async function prepareHeroVideoUploadAssets(
  options: PrepareHeroVideoUploadAssetsOptions = {},
): Promise<void> {
  const bundleDir = options.bundleDir ?? DEFAULT_BUNDLE_DIR;
  const uploadDir = options.uploadDir ?? join(bundleDir, '.debug/video-upload');
  await rm(uploadDir, { recursive: true, force: true });
  await mkdir(uploadDir, { recursive: true });

  const checksumLines: string[] = [];
  for (const agent of AGENTS) {
    const inputPath = join(bundleDir, 'artifacts', `${agent}-outer.webm`);
    const outputPath = join(uploadDir, `${agent}-outer-h264.mp4`);
    const probePath = join(uploadDir, `${agent}-outer-h264.ffprobe.json`);
    await assertNonEmptyFile(inputPath);
    run(toolCommand('HERO_VIDEO_FFMPEG', 'ffmpeg'), [
      '-y',
      '-i',
      inputPath,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'medium',
      '-crf',
      '28',
      '-movflags',
      '+faststart',
      outputPath,
    ]);
    await assertNonEmptyFile(outputPath);
    const probeJson = run(toolCommand('HERO_VIDEO_FFPROBE', 'ffprobe'), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt,width,height,duration',
      '-show_entries',
      'format=size,duration,format_name',
      '-of',
      'json',
      outputPath,
    ]);
    await writeFile(probePath, probeJson);
    const repoRelativeOutput = relative(REPO_ROOT, outputPath);
    checksumLines.push(
      `${await sha256File(outputPath)}  ${repoRelativeOutput}`,
    );
  }
  await writeFile(
    join(uploadDir, 'SHA256SUMS'),
    `${checksumLines.join('\n')}\n`,
  );

  process.stdout.write(
    `Prepared upload assets in ${relative(REPO_ROOT, uploadDir)}\n`,
  );
}

export async function applyHeroVideoUrls(
  options: ApplyHeroVideoUrlsOptions,
): Promise<void> {
  const rootReadmePath = options.rootReadmePath ?? DEFAULT_ROOT_README;
  const bundleDir = options.bundleDir ?? DEFAULT_BUNDLE_DIR;
  for (const agent of AGENTS) {
    assertAttachmentUrl(options.urls[agent], agent);
  }

  let rootReadme = await readFile(rootReadmePath, 'utf8');
  for (const agent of AGENTS) {
    const link = README_LINKS[agent];
    rootReadme = updateReadmeLink(
      rootReadme,
      link.rootAlt,
      link.rootThumbnail,
      options.urls[agent],
    );
  }
  await writeFile(rootReadmePath, rootReadme);

  const bundleReadmePath = join(bundleDir, 'README.md');
  let bundleReadme = await readFile(bundleReadmePath, 'utf8');
  for (const agent of AGENTS) {
    const link = README_LINKS[agent];
    bundleReadme = updateReadmeLink(
      bundleReadme,
      link.bundleAlt,
      link.bundleThumbnail,
      options.urls[agent],
    );
  }
  await writeFile(bundleReadmePath, bundleReadme);
  await updateManifest(bundleDir, ['README.md']);

  process.stdout.write('Applied Hero Demo video URLs.\n');
}

function usage(): string {
  return [
    'Usage:',
    '  hero-video-playback prepare-upload-assets [--bundle-dir DIR] [--upload-dir DIR]',
    '  hero-video-playback apply-video-urls --codex-url URL --claude-url URL [--bundle-dir DIR] [--root-readme PATH]',
    '',
  ].join('\n');
}

async function main(args: string[]): Promise<void> {
  const command = args.shift();
  if (command === '--help' || command === 'help') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'prepare-upload-assets') {
    const bundleDir = readFlag(args, '--bundle-dir');
    const uploadDir = readFlag(args, '--upload-dir');
    invariant(args.length === 0, `unexpected arguments: ${args.join(' ')}`);
    const options: PrepareHeroVideoUploadAssetsOptions = {};
    if (bundleDir !== undefined) {
      options.bundleDir = bundleDir;
    }
    if (uploadDir !== undefined) {
      options.uploadDir = uploadDir;
    }
    await prepareHeroVideoUploadAssets(options);
    return;
  }
  if (command === 'apply-video-urls') {
    const codexUrl = readFlag(args, '--codex-url');
    const claudeUrl = readFlag(args, '--claude-url');
    const bundleDir = readFlag(args, '--bundle-dir');
    const rootReadmePath = readFlag(args, '--root-readme');
    invariant(codexUrl !== undefined, 'missing --codex-url');
    invariant(claudeUrl !== undefined, 'missing --claude-url');
    invariant(args.length === 0, `unexpected arguments: ${args.join(' ')}`);
    const options: ApplyHeroVideoUrlsOptions = {
      urls: { codex: codexUrl, claude: claudeUrl },
    };
    if (rootReadmePath !== undefined) {
      options.rootReadmePath = rootReadmePath;
    }
    if (bundleDir !== undefined) {
      options.bundleDir = bundleDir;
    }
    await applyHeroVideoUrls(options);
    return;
  }
  throw new Error(
    `${command === undefined ? 'missing command' : `unknown command: ${command}`}\n${usage()}`,
  );
}

if (isDirectExecution(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
