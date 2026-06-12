import { describe, expect, it } from 'vitest';

// Deep imports into release-please internals: these tests pin the
// compatibility contract the runner depends on but release-please does not
// document — the merged release PR body must parse back into a version +
// notes, otherwise no GitHub Release is created on merge.
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import {
  PullRequestTitle,
  generateMatchPattern,
} from 'release-please/build/src/util/pull-request-title.js';
import { Version } from 'release-please/build/src/version.js';

import {
  UnreleasedAwareChangelog,
  assertLlmCredentials,
  buildCommuniqueArgs,
  createCommuniqueChangelogNotes,
  formatChangelogSection,
  formatOutputs,
  normalizeCommuniqueBody,
  todayIsoDate,
} from '../../../src/tools/release-please-runner.js';
import { writeFileSync } from 'node:fs';

const SAMPLE_BODY = [
  '### Added',
  '',
  '- `agent-tty ls` is now a short alias for `agent-tty list` ([#135](https://github.com/coder/agent-tty/pull/135)).',
  '',
  '### Changed',
  '',
  '- `record export --format webm` now defaults to `--timing recorded` ([#139](https://github.com/coder/agent-tty/pull/139)).',
].join('\n');

describe('assertLlmCredentials', () => {
  it('accepts an Anthropic key alone', () => {
    expect(() =>
      assertLlmCredentials({ ANTHROPIC_API_KEY: 'sk-ant' }),
    ).not.toThrow();
  });

  it('requires a model with an OpenAI-only key', () => {
    expect(() => assertLlmCredentials({ OPENAI_API_KEY: 'sk-oai' })).toThrow(
      'COMMUNIQUE_MODEL',
    );
    expect(() =>
      assertLlmCredentials({ OPENAI_API_KEY: 'sk-oai', COMMUNIQUE_MODEL: 'm' }),
    ).not.toThrow();
  });

  it('rejects when no key is present', () => {
    expect(() => assertLlmCredentials({})).toThrow(
      'ANTHROPIC_API_KEY or OPENAI_API_KEY',
    );
  });
});

describe('buildCommuniqueArgs', () => {
  it('passes the previous tag explicitly so ranges match release-please', () => {
    expect(
      buildCommuniqueArgs({
        repo: 'coder/agent-tty',
        outputFile: '/tmp/notes.md',
        previousTag: 'v0.4.1',
        model: 'claude-opus-4-7',
      }),
    ).toEqual([
      'generate',
      'HEAD',
      'v0.4.1',
      '--concise',
      '--repo',
      'coder/agent-tty',
      '--output',
      '/tmp/notes.md',
      '--model',
      'claude-opus-4-7',
    ]);
  });

  it('lets communique auto-detect the previous tag when unknown', () => {
    expect(
      buildCommuniqueArgs({ repo: 'coder/agent-tty', outputFile: '/n.md' }),
    ).toEqual([
      'generate',
      'HEAD',
      '--concise',
      '--repo',
      'coder/agent-tty',
      '--output',
      '/n.md',
    ]);
  });
});

describe('formatChangelogSection', () => {
  it('uses the bracketed no-v heading with the house date style', () => {
    const section = formatChangelogSection('0.4.2', '2026-06-12', SAMPLE_BODY);
    expect(section.startsWith('## [0.4.2] - 2026-06-12\n\n### Added')).toBe(
      true,
    );
    expect(section.endsWith('\n')).toBe(false);
  });

  it('falls back to a maintenance bullet for empty notes', () => {
    // An empty section would trip release-please's changelogEmpty() check and
    // silently skip the release PR even when releasable commits exist.
    expect(formatChangelogSection('0.4.2', '2026-06-12', '  \n')).toBe(
      '## [0.4.2] - 2026-06-12\n\n- Maintenance release with no user-facing changes.',
    );
  });
});

describe('normalizeCommuniqueBody', () => {
  it('demotes stray H2 section headings to the house H3 style', () => {
    // Observed in a live run: communique --concise emitted `## Changed`
    // where the historical changelog nests `### Changed` under the version.
    expect(normalizeCommuniqueBody('## Changed\n\n- A change.')).toBe(
      '### Changed\n\n- A change.',
    );
  });

  it('drops a duplicate leading version heading', () => {
    expect(
      normalizeCommuniqueBody('## [0.4.2] - 2026-06-12\n\n### Added\n\n- X.'),
    ).toBe('### Added\n\n- X.');
  });

  it('leaves house-style bodies untouched', () => {
    expect(normalizeCommuniqueBody(SAMPLE_BODY)).toBe(SAMPLE_BODY);
  });
});

describe('todayIsoDate', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(todayIsoDate(new Date('2026-06-12T23:59:59Z'))).toBe('2026-06-12');
  });
});

describe('release PR body round-trip (release-please compatibility)', () => {
  it('parses the version and notes back out of the generated body', () => {
    const notes = formatChangelogSection('0.4.2', '2026-06-12', SAMPLE_BODY);
    const body = new PullRequestBody([
      { version: Version.parse('0.4.2'), notes },
    ]);

    const parsed = PullRequestBody.parse(body.toString());

    expect(parsed).toBeDefined();
    expect(parsed?.releaseData).toHaveLength(1);
    expect(parsed?.releaseData[0]?.version?.toString()).toBe('0.4.2');
    expect(parsed?.releaseData[0]?.notes).toContain('### Added');
  });

  it('documents why the heading must not carry a v prefix', () => {
    // `extractSingleRelease` matches /^#{2,} \[?(\d+\.\d+\.\d+...)/ — a digit
    // must follow the optional bracket. With `## [v0.4.2]` the body yields no
    // release data, and buildRelease() would create a release with no notes.
    const body = new PullRequestBody([
      {
        version: Version.parse('0.4.2'),
        notes: '## [v0.4.2] - 2026-06-12\n\n- entry',
      },
    ]);
    const parsed = PullRequestBody.parse(body.toString());
    expect(parsed?.releaseData).toHaveLength(0);
  });

  it('parses the release version from the configured PR title pattern', () => {
    const pattern = 'chore(release): ${version}';
    const title = PullRequestTitle.ofVersion(
      Version.parse('0.4.2'),
      pattern,
    ).toString();
    expect(title).toBe('chore(release): 0.4.2');

    expect(generateMatchPattern(pattern).test(title)).toBe(true);
    const parsed = PullRequestTitle.parse(title, pattern);
    expect(parsed?.getVersion()?.toString()).toBe('0.4.2');
  });
});

describe('UnreleasedAwareChangelog', () => {
  const entry = formatChangelogSection('0.4.2', '2026-06-13', SAMPLE_BODY);
  const previousSections = [
    '## [v0.4.1] - 2026-06-12',
    '',
    '### Added',
    '',
    '- Older entry ([#135](https://github.com/coder/agent-tty/pull/135)).',
    '',
    '## [v0.4.0] - 2026-06-08',
    '',
    '### Added',
    '',
    '- Oldest entry.',
    '',
  ].join('\n');

  it('keeps the empty Unreleased anchor and inserts the section below it', () => {
    const existing = `# Changelog\n\n## [Unreleased]\n\n${previousSections}`;
    const updated = new UnreleasedAwareChangelog({
      changelogEntry: entry,
    }).updateContent(existing);

    expect(updated).toBe(
      `# Changelog\n\n## [Unreleased]\n\n${entry}\n\n${previousSections.trim()}\n`,
    );
  });

  it('clears a hand-staged draft body, including H3 subsections', () => {
    // Communique reconciles the draft into the generated notes before this
    // updater runs; leaving it in place would leak it into every later
    // release.
    const existing = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '',
      '- Hand-staged draft bullet.',
      '',
      previousSections,
    ].join('\n');
    const updated = new UnreleasedAwareChangelog({
      changelogEntry: entry,
    }).updateContent(existing);

    expect(updated).not.toContain('Hand-staged draft bullet');
    expect(updated.indexOf('## [Unreleased]')).toBeLessThan(
      updated.indexOf('## [0.4.2] - 2026-06-13'),
    );
    expect(updated.indexOf('## [0.4.2] - 2026-06-13')).toBeLessThan(
      updated.indexOf('## [v0.4.1] - 2026-06-12'),
    );
  });

  it('accepts the bracketless Unreleased variant communique also allows', () => {
    const existing = `# Changelog\n\n## Unreleased\n\n${previousSections}`;
    const updated = new UnreleasedAwareChangelog({
      changelogEntry: entry,
    }).updateContent(existing);

    expect(updated).toContain(`## Unreleased\n\n${entry}\n\n## [v0.4.1]`);
  });

  it('self-heals a missing Unreleased anchor below the title', () => {
    const existing = `# Changelog\n\n${previousSections}`;
    const updated = new UnreleasedAwareChangelog({
      changelogEntry: entry,
    }).updateContent(existing);

    expect(updated).toBe(
      `# Changelog\n\n## [Unreleased]\n\n${entry}\n\n${previousSections.trim()}\n`,
    );
  });

  it('scaffolds a fresh changelog when the file is missing', () => {
    const updated = new UnreleasedAwareChangelog({
      changelogEntry: entry,
    }).updateContent(undefined);

    expect(updated).toBe(`# Changelog\n\n## [Unreleased]\n\n${entry}\n`);
  });
});

describe('createCommuniqueChangelogNotes', () => {
  it('invokes communique with the release range and wraps its output', async () => {
    const invocations: string[][] = [];
    const notes = createCommuniqueChangelogNotes(
      (args) => {
        invocations.push(args);
        const outputFlag = args.indexOf('--output');
        writeFileSync(args[outputFlag + 1] as string, `${SAMPLE_BODY}\n`);
        return Promise.resolve();
      },
      { ANTHROPIC_API_KEY: 'sk-ant' },
    );

    const section = await notes.buildNotes([], {
      owner: 'coder',
      repository: 'agent-tty',
      version: '0.4.2',
      previousTag: 'v0.4.1',
      currentTag: 'v0.4.2',
      targetBranch: 'main',
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.slice(0, 3)).toEqual(['generate', 'HEAD', 'v0.4.1']);
    expect(invocations[0]).toContain('--concise');
    expect(
      section.startsWith(`## [0.4.2] - ${todayIsoDate()}\n\n### Added`),
    ).toBe(true);
  });

  it('fails fast without LLM credentials', async () => {
    const notes = createCommuniqueChangelogNotes(() => Promise.resolve(), {});
    await expect(
      notes.buildNotes([], {
        owner: 'coder',
        repository: 'agent-tty',
        version: '0.4.2',
        currentTag: 'v0.4.2',
        targetBranch: 'main',
      }),
    ).rejects.toThrow('ANTHROPIC_API_KEY or OPENAI_API_KEY');
  });
});

describe('formatOutputs', () => {
  it('maps releases and pull requests into workflow outputs', () => {
    const outputs = formatOutputs(
      [
        undefined,
        {
          tagName: 'v0.4.2',
          headBranchName: 'x',
        } as unknown as Parameters<typeof formatOutputs>[0][number],
      ],
      [
        {
          headBranchName: 'release-please--branches--main',
        } as unknown as Parameters<typeof formatOutputs>[1][number],
        undefined,
      ],
    );
    expect(outputs).toEqual({
      prs_created: 'true',
      pr_branches: 'release-please--branches--main',
      releases_created: 'true',
      release_tags: 'v0.4.2',
    });
  });

  it('reports false when nothing was created', () => {
    expect(formatOutputs([], [undefined])).toEqual({
      prs_created: 'false',
      pr_branches: '',
      releases_created: 'false',
      release_tags: '',
    });
  });
});
