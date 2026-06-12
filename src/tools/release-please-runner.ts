/**
 * Release Please runner with Communique changelog notes.
 *
 * The stock `googleapis/release-please-action` only supports its built-in
 * `default` (conventional-commit bullets) and `github` (auto-generated notes)
 * changelog generators. This repo's changelog sections are written by
 * Communique, so we run release-please as a library instead and register
 * Communique as a custom changelog-notes type — `"changelog-type":
 * "communique"` in `release-please-config.json` routes note building here.
 *
 * On every push to `main` (.github/workflows/release-please.yml):
 *   1. `createReleases()` — if a release PR merged, create the `v<version>`
 *      tag and the GitHub Release (notes parsed from the merged PR body).
 *   2. `createPullRequests()` — open or update the single release PR carrying
 *      the version bump plus a Communique-written CHANGELOG section.
 *
 * The workflow reads this script's GITHUB_OUTPUT values to dispatch CI onto
 * the release branch (pushes made with the workflow token never trigger
 * `pull_request` events) and the tag-driven Release pipeline (tags created
 * with the workflow token never trigger `push: tags` events).
 *
 * CHANGELOG.md keeps a `## [Unreleased]` section at the top: Communique
 * requires the heading to exist and reconciles any hand-staged draft body
 * into the notes it generates. A custom updater (see
 * {@link UnreleasedAwareChangelog}) therefore inserts release sections below
 * that heading and clears the reconciled draft.
 *
 * Run `npx tsx src/tools/release-please-runner.ts --dry-run` with
 * GITHUB_TOKEN/GITHUB_REPOSITORY and an LLM key to preview the candidate
 * release PR and releases without mutating anything on GitHub.
 */

import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  GitHub,
  Manifest,
  registerChangelogNotes,
  registerReleaseType,
  type BuildUpdatesOptions,
  type ChangelogNotes,
  type CreatedRelease,
  type PullRequest,
} from 'release-please';
// Deep imports: neither the Node strategy class nor the stock Changelog
// updater is re-exported from the package root, and release-please ships no
// `exports` map restricting subpath access.
import { Node } from 'release-please/build/src/strategies/node.js';
import { Changelog } from 'release-please/build/src/updaters/changelog.js';
import type { Update } from 'release-please/build/src/update.js';

import { isDirectExecution } from '../util/isDirectExecution.js';

const execFileAsync = promisify(execFile);

/**
 * Mirrors the credential contract of the retired changelog workflows:
 * Anthropic works standalone, OpenAI-compatible endpoints additionally need
 * an explicit model selection.
 */
export function assertLlmCredentials(env: NodeJS.ProcessEnv): void {
  const anthropicKey = env.ANTHROPIC_API_KEY ?? '';
  const openaiKey = env.OPENAI_API_KEY ?? '';
  const model = env.COMMUNIQUE_MODEL ?? '';
  if (anthropicKey === '' && openaiKey === '') {
    throw new Error(
      'ANTHROPIC_API_KEY or OPENAI_API_KEY is required to generate changelog entries with Communique.',
    );
  }
  if (anthropicKey === '' && model === '') {
    throw new Error(
      'Set COMMUNIQUE_MODEL when using OPENAI_API_KEY so Communique can select an OpenAI-compatible model.',
    );
  }
}

export interface CommuniqueInvocation {
  readonly repo: string;
  readonly outputFile: string;
  readonly previousTag?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * `communique generate HEAD [PREV_TAG] --concise` emits the changelog-entry
 * flavor (the same content `--changelog` would insert into CHANGELOG.md)
 * without touching any files. The previous tag is passed explicitly so
 * Communique and release-please always agree on the commit range.
 */
export function buildCommuniqueArgs(
  invocation: CommuniqueInvocation,
): string[] {
  const args = ['generate', 'HEAD'];
  if (invocation.previousTag !== undefined && invocation.previousTag !== '') {
    args.push(invocation.previousTag);
  }
  args.push('--concise', '--repo', invocation.repo);
  args.push('--output', invocation.outputFile);
  if (invocation.model !== undefined && invocation.model !== '') {
    args.push('--model', invocation.model);
  }
  return args;
}

/**
 * Formats the section that becomes the CHANGELOG.md entry, the release PR
 * body, and (after merge) the GitHub Release notes.
 *
 * The heading is `## [<version>] - <date>` — close to this repo's historical
 * `## [v<version>] - <date>` style, but without the `v`: release-please
 * parses the merged PR body with `/^#{2,} \[?(?<version>\d+\.\d+\.\d+...)/`,
 * which requires a digit immediately after the optional bracket. A `v` there
 * would make the merged release PR unparseable and no release would be
 * created.
 */
/**
 * Guards the generated section body against LLM drift: drops a leading
 * version heading if Communique emitted one (the runner prepends its own
 * canonical heading), and demotes stray H2 section headings to the H3 the
 * historical CHANGELOG nests under each version (`### Added` / `### Changed`).
 */
export function normalizeCommuniqueBody(body: string): string {
  return body
    .trim()
    .replace(/^#{2,3} \[?v?\d[^\n]*\n*/, '')
    .replace(/^## (?!\[)/gm, '### ')
    .trim();
}

export function formatChangelogSection(
  version: string,
  isoDate: string,
  body: string,
): string {
  const normalized = normalizeCommuniqueBody(body);
  const content =
    normalized === ''
      ? '- Maintenance release with no user-facing changes.'
      : normalized;
  // No trailing newline: the changelog updater joins the entry with `\n\n` on
  // both sides, so a trailing newline here would leave a double blank line
  // above the previous section.
  return `## [${version}] - ${isoDate}\n\n${content}`;
}

export function todayIsoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type CommuniqueRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;

async function runCommuniqueBinary(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const { stderr } = await execFileAsync('communique', args, {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (stderr.trim() !== '') {
      process.stderr.write(stderr);
    }
  } catch (error) {
    const stderr =
      error instanceof Object && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    throw new Error(
      `communique ${args.join(' ')} failed${stderr === '' ? '' : `:\n${stderr}`}`,
      { cause: error },
    );
  }
}

export function createCommuniqueChangelogNotes(
  runCommunique: CommuniqueRunner = runCommuniqueBinary,
  env: NodeJS.ProcessEnv = process.env,
): ChangelogNotes {
  return {
    async buildNotes(_commits, options) {
      assertLlmCredentials(env);
      const scratchDir = mkdtempSync(join(tmpdir(), 'communique-notes-'));
      const outputFile = join(scratchDir, 'notes.md');
      try {
        const args = buildCommuniqueArgs({
          repo: `${options.owner}/${options.repository}`,
          outputFile,
          previousTag: options.previousTag,
          model: env.COMMUNIQUE_MODEL,
        });
        await runCommunique(args, env);
        const body = readFileSync(outputFile, 'utf8');
        return formatChangelogSection(options.version, todayIsoDate(), body);
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    },
  };
}

const UNRELEASED_HEADING_PATTERN = /^#{2,3} \[?Unreleased\]?[ \t]*$/m;
// An H1 or H2 heading ends the Unreleased section; H3 stays inside it because
// hand-staged drafts use Keep-a-Changelog `### Added`-style subsections.
const NEXT_SECTION_PATTERN = /^##? /m;
const TITLE_PATTERN = /^# .+$/m;

/**
 * Replaces release-please's stock Changelog updater, which would insert the
 * new section at the first `\n###? v?[0-9[]` match — and `## [Unreleased]`
 * matches that pattern, so the release section would land *above* it.
 *
 * The `[Unreleased]` heading must stay at the top of CHANGELOG.md: Communique
 * refuses to run without it, and it feeds the section's body to the LLM as
 * draft material to reconcile into the generated notes. This updater keeps
 * the heading, drops the draft body (Communique has already folded it into
 * `changelogEntry` by the time this runs), and inserts the new release
 * section directly below.
 */
export class UnreleasedAwareChangelog {
  readonly changelogEntry: string;

  constructor(options: { changelogEntry: string }) {
    this.changelogEntry = options.changelogEntry;
  }

  updateContent(content: string | undefined): string {
    const existing = (content ?? '').replace(/\r\n/g, '\n');
    const entry = this.changelogEntry.trim();
    const heading = UNRELEASED_HEADING_PATTERN.exec(existing);

    if (heading !== null) {
      const headingEnd = heading.index + heading[0].length;
      const head = existing.slice(0, headingEnd);
      const tail = existing.slice(headingEnd);
      const next = NEXT_SECTION_PATTERN.exec(tail);
      const rest = next === null ? '' : tail.slice(next.index);
      return joinSections(head, entry, rest);
    }

    // Self-heal a missing Unreleased anchor so Communique keeps working on
    // the next run.
    const title = TITLE_PATTERN.exec(existing);
    if (title !== null) {
      const titleEnd = title.index + title[0].length;
      const head = `${existing.slice(0, titleEnd)}\n\n## [Unreleased]`;
      return joinSections(head, entry, existing.slice(titleEnd));
    }
    return joinSections('# Changelog\n\n## [Unreleased]', entry, existing);
  }
}

function joinSections(head: string, entry: string, rest: string): string {
  const sections = [head.trimEnd(), entry];
  if (rest.trim() !== '') {
    sections.push(rest.trim());
  }
  return `${sections.join('\n\n')}\n`;
}

/**
 * The stock `node` strategy with the CHANGELOG.md updater swapped for
 * {@link UnreleasedAwareChangelog}. Registered over the builtin `node` type so
 * `release-please-config.json` keeps the standard `"release-type": "node"`.
 */
export class CommuniqueNodeStrategy extends Node {
  protected override async buildUpdates(
    options: BuildUpdatesOptions,
  ): Promise<Update[]> {
    const updates = await super.buildUpdates(options);
    return updates.map((update) =>
      update.updater instanceof Changelog
        ? {
            ...update,
            updater: new UnreleasedAwareChangelog({
              changelogEntry: update.updater.changelogEntry,
            }),
          }
        : update,
    );
  }
}

export interface RunnerOutputs {
  readonly prs_created: string;
  readonly pr_branches: string;
  readonly releases_created: string;
  readonly release_tags: string;
}

export function formatOutputs(
  releases: readonly (CreatedRelease | undefined)[],
  pullRequests: readonly (PullRequest | undefined)[],
): RunnerOutputs {
  const tags = releases
    .filter((release): release is CreatedRelease => release !== undefined)
    .map((release) => release.tagName);
  const branches = pullRequests
    .filter((pr): pr is PullRequest => pr !== undefined)
    .map((pr) => pr.headBranchName);
  return {
    prs_created: branches.length > 0 ? 'true' : 'false',
    pr_branches: branches.join(' '),
    releases_created: tags.length > 0 ? 'true' : 'false',
    release_tags: tags.join(' '),
  };
}

function writeGithubOutputs(outputs: RunnerOutputs): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  if (outputPath === undefined || outputPath === '') {
    process.stdout.write(`${lines}\n`);
    return;
  }
  appendFileSync(outputPath, `${lines}\n`);
}

/**
 * Dry-run aid: applies the candidate PR's CHANGELOG.md update to the local
 * working-tree copy so the resulting file can be inspected without pushing.
 */
function previewChangelog(updates: readonly Update[]): string | undefined {
  const changelogUpdate = updates.find(
    (update) => update.updater instanceof UnreleasedAwareChangelog,
  );
  if (changelogUpdate === undefined) {
    return undefined;
  }
  let current: string | undefined;
  try {
    current = readFileSync(changelogUpdate.path, 'utf8');
  } catch {
    current = undefined;
  }
  return changelogUpdate.updater.updateContent(current);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const token = requireEnv('GITHUB_TOKEN');
  const repository = requireEnv('GITHUB_REPOSITORY');
  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined || repo === '') {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo, got: ${repository}`);
  }

  registerChangelogNotes('communique', () => createCommuniqueChangelogNotes());
  registerReleaseType('node', (options) => new CommuniqueNodeStrategy(options));

  const github = await GitHub.create({ owner, repo, token });
  // The override exists for --dry-run debugging against a feature branch
  // (release-please reads release-please-config.json and the manifest from
  // the *remote* target branch, not the local checkout).
  const targetBranch =
    process.env.RELEASE_PLEASE_TARGET_BRANCH ?? github.repository.defaultBranch;
  const manifest = await Manifest.fromManifest(github, targetBranch);

  if (dryRun) {
    const candidateReleases = await manifest.buildReleases();
    const candidatePullRequests = await manifest.buildPullRequests();
    process.stdout.write(
      `${JSON.stringify(
        {
          releases: candidateReleases.map((release) => ({
            tag: release.tag.toString(),
            sha: release.sha,
            notes: release.notes,
          })),
          pullRequests: candidatePullRequests.map((pullRequest) => ({
            title: pullRequest.title.toString(),
            headBranchName: pullRequest.headRefName,
            version: pullRequest.version?.toString(),
            body: pullRequest.body.toString(),
            changelogPreview: previewChangelog(pullRequest.updates),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // Releases first, then PRs — same order as release-please-action: the run
  // triggered by a release PR merge tags that release before considering a
  // new PR for any commits that landed since.
  const releases = await manifest.createReleases();
  const pullRequests = await manifest.createPullRequests();
  const outputs = formatOutputs(releases, pullRequests);
  writeGithubOutputs(outputs);
  process.stdout.write(
    `release-please: releases=[${outputs.release_tags}] prs=[${outputs.pr_branches}]\n`,
  );
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
