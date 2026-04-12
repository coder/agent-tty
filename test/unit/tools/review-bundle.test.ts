import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BundleManifestSchema,
  buildReviewBundle,
  classifyBundlePath,
  normalizeBundleManifest,
  renderTinyMarkdown,
  runReviewBundleCli,
  scanBundleArtifacts,
} from '../../../src/tools/review-bundle.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  // prettier-ignore
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-review-bundle-')));
  tempDirs.push(directory);
  return directory;
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('review-bundle helpers', () => {
  it('parses modern manifests and normalizes legacy and missing manifests', () => {
    const modernManifest = {
      bundle: '20260322-dogfood-alt-screen',
      title: 'Alt screen review',
      description: 'Portable review bundle',
      createdAt: '2026-03-22T12:00:00.000Z',
      commands: ['create', 'wait'],
      artifacts: [{ path: 'screenshots/alternate.png', size: 123 }],
    };
    expect(BundleManifestSchema.safeParse(modernManifest).success).toBe(true);
    expect(
      BundleManifestSchema.safeParse({
        bundle: 'bad-bundle',
        artifacts: [{ path: 42 }],
      }).success,
    ).toBe(false);

    const legacyMetadata = normalizeBundleManifest(
      {
        scenario: 'resize-demo',
        date: '2026-03-19',
        sessionId: '01TEST',
        result: 'pass',
        commands: ['create', 'resize', 'destroy'],
      },
      '20260319-resize-demo',
    );
    expect(legacyMetadata.title).toBe('resize-demo');
    expect(legacyMetadata.source).toBe('schema');
    expect(legacyMetadata.commandLabels).toEqual([
      'create',
      'resize',
      'destroy',
    ]);

    const missingMetadata = normalizeBundleManifest(
      null,
      'bundle-without-manifest',
    );
    expect(missingMetadata.title).toBe('bundle-without-manifest');
    expect(missingMetadata.source).toBe('scan');
  });

  it('classifies scanned artifacts across flat and categorized layouts', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(
      bundleRoot,
      'manifest.json',
      '{"bundle":"fixture"}\n',
    );
    await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');
    await writeFixtureFile(bundleRoot, 'screenshots/primary.png', 'png');
    await writeFixtureFile(bundleRoot, 'videos/demo.webm', 'webm');
    await writeFixtureFile(bundleRoot, 'recordings/demo.cast', 'cast');
    await writeFixtureFile(bundleRoot, 'doctor.json', '{"ok":true}\n');
    await writeFixtureFile(bundleRoot, 'logs/01-create.json.stderr.txt', '');
    await writeFixtureFile(bundleRoot, 'misc/output.bin', 'other');

    const scannedArtifacts = await scanBundleArtifacts(bundleRoot);
    expect(scannedArtifacts.map((artifact) => artifact.relativePath)).toEqual([
      'doctor.json',
      'logs/01-create.json.stderr.txt',
      'manifest.json',
      'misc/output.bin',
      'notes.md',
      'recordings/demo.cast',
      'screenshots/primary.png',
      'videos/demo.webm',
    ]);
    expect(classifyBundlePath('screenshots/primary.png')).toBe('screenshot');
    expect(classifyBundlePath('videos/demo.webm')).toBe('video');
    expect(classifyBundlePath('recordings/demo.cast')).toBe('recording');
    expect(classifyBundlePath('notes.md')).toBe('notes');
    expect(classifyBundlePath('doctor.json')).toBe('support');
    expect(classifyBundlePath('misc/output.bin')).toBe('other');
  });

  it('renders tiny markdown safely with headings, lists, code, emphasis, and links', () => {
    const html = renderTinyMarkdown(`# Heading

- **bold** item
- *italic* step

Paragraph with \`inline\` and [link](./notes.md).

1. first
2. second

\`\`\`ts
const x = 1 < 2;
\`\`\`

<script>alert(1)</script>`);

    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain(
      '<ul><li><strong>bold</strong> item</li><li><em>italic</em> step</li></ul>',
    );
    expect(html).toContain('<code>inline</code>');
    expect(html).toContain('<a href="./notes.md">link</a>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain(
      '<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('builds a portable review page with screenshots, videos, notes, commands, JSON, and inventory', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(
      bundleRoot,
      'manifest.json',
      JSON.stringify(
        {
          bundle: 'portable-review',
          title: 'Portable review',
          description: 'Bundle description',
          date: '2026-03-23',
          commands: [{ name: 'create' }, { command: 'wait --json' }],
          artifacts: [{ path: 'screenshots/demo.png' }],
        },
        null,
        2,
      ),
    );
    await writeFixtureFile(bundleRoot, '01-create.json', '{"ok":true}\n');
    await writeFixtureFile(bundleRoot, 'commands.sh', 'echo hello\n');
    await writeFixtureFile(
      bundleRoot,
      'command-status.tsv',
      'step\texit_code\tcommand\n01-create.json\t0\tnpx tsx src/cli/main.ts create --json\n',
    );
    await writeFixtureFile(
      bundleRoot,
      'notes.md',
      '# Notes\n\n- **bold**\n- *italic*\n\nParagraph with `code` and [link](./commands.sh).\n\n```sh\necho hi\n```\n\n<script>alert(1)</script>\n',
    );
    await writeFixtureFile(bundleRoot, 'screenshots/demo.png', 'png-bytes');
    await writeFixtureFile(bundleRoot, 'videos/demo.webm', 'webm-bytes');
    await writeFixtureFile(bundleRoot, 'recordings/demo.cast', 'cast-bytes');
    await writeFixtureFile(bundleRoot, 'misc/output.bin', 'other');

    const indexPath = await buildReviewBundle(bundleRoot);
    const html = await readFile(indexPath, 'utf8');

    expect(html).toContain('<h1>Portable review</h1>');
    expect(html).toContain('Bundle description');
    expect(html).toContain('Screenshot gallery');
    expect(html).toContain('Video gallery');
    expect(html).toContain('Recordings');
    expect(html).toContain('JSON outputs');
    expect(html).toContain('Notes');
    expect(html).toContain('Commands');
    expect(html).toContain('Command status');
    expect(html).toContain('Artifact inventory');
    expect(html).toContain('<details class="card">');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<a href="./commands.sh">link</a>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('screenshots/demo.png');
    expect(html).toContain('videos/demo.webm');
    expect(html).toContain('recordings/demo.cast');
    expect(html).toContain('misc/output.bin');
    expect(html).not.toContain('index.html</a></td>');
  });

  it('rejects manifest artifact path traversal', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(
      bundleRoot,
      'manifest.json',
      JSON.stringify({
        bundle: 'escape-attempt',
        artifacts: [{ path: '../escape.png' }],
      }),
    );

    await expect(buildReviewBundle(bundleRoot)).rejects.toThrow(
      'bundle artifact path escapes bundle root',
    );
  });

  it('runs the CLI in single-bundle mode and all-bundles mode with partial failures', async () => {
    const singleBundle = await createTempDir();
    await writeFixtureFile(singleBundle, 'notes.md', '# Single bundle\n');

    const singleStdout: string[] = [];
    const singleStderr: string[] = [];
    const singleExitCode = await runReviewBundleCli([singleBundle], {
      stdout: (text) => singleStdout.push(text),
      stderr: (text) => singleStderr.push(text),
    });
    expect(singleExitCode).toBe(0);
    expect(singleStdout.join('')).toContain(join(singleBundle, 'index.html'));
    expect(singleStderr.join('')).toContain(`Building ${singleBundle}`);

    const parentDirectory = await createTempDir();
    const goodBundle = join(parentDirectory, 'good-bundle');
    const badBundle = join(parentDirectory, 'bad-bundle');
    await mkdir(goodBundle, { recursive: true });
    await mkdir(badBundle, { recursive: true });
    await writeFixtureFile(goodBundle, 'notes.md', '# Good bundle\n');
    await writeFixtureFile(
      badBundle,
      'manifest.json',
      JSON.stringify({ artifacts: [{ path: '../escape.png' }] }),
    );

    const allStdout: string[] = [];
    const allStderr: string[] = [];
    const allExitCode = await runReviewBundleCli(['--all', parentDirectory], {
      stdout: (text) => allStdout.push(text),
      stderr: (text) => allStderr.push(text),
    });
    expect(allExitCode).toBe(1);
    expect(allStdout.join('')).toContain(join(goodBundle, 'index.html'));
    expect(allStdout.join('')).not.toContain(join(badBundle, 'index.html'));
    expect(allStderr.join('')).toContain(`Building ${badBundle}`);
    expect(allStderr.join('')).toContain(`Building ${goodBundle}`);
    expect(allStderr.join('')).toContain(`Failed to build ${badBundle}`);
  });
});
