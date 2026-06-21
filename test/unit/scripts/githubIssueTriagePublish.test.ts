import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const publisherPath = new URL(
  '../../../scripts/github-issue-triage-publish.mjs',
  import.meta.url,
).pathname;
const marker = '<!-- agent-tty-triage:coder/agent-tty#1 -->';
const snapshotStdout = '{"snapshot":true}';
const snapshotHash = createHash('sha256')
  .update(snapshotStdout, 'utf8')
  .digest('hex');

type PublishPlan = {
  kind: 'triage-comment' | 'risk-stop';
  repository: string;
  issue: number;
  marker: string;
  commentBody: string;
  labelsToAdd: string[];
  labelsToRemove: string[];
  allowedLabels: string[];
  preconditions: {
    state: string;
    requiredLabels: string[];
    absentLabels: string[];
    conversationHash: string;
  };
};

function triagePlan(overrides: Partial<PublishPlan> = {}): PublishPlan {
  return {
    kind: 'triage-comment',
    repository: 'coder/agent-tty',
    issue: 1,
    marker,
    commentBody:
      marker +
      '\n> [!NOTE]\n> This triage report is AI-generated using Mux\n\nReady.',
    labelsToAdd: ['ready-for-agent', 'triage:done'],
    labelsToRemove: [],
    allowedLabels: [
      'needs-triage',
      'ready-for-agent',
      'triage:done',
      'triage:ongoing',
      'triage:stopped',
      'risk:high',
    ],
    preconditions: {
      state: 'open',
      requiredLabels: ['needs-triage'],
      absentLabels: ['triage:done', 'triage:ongoing', 'triage:stopped'],
      conversationHash: snapshotHash,
    },
    ...overrides,
  };
}

async function runPublisher(plan: PublishPlan, scenario: string) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-tty-publish-test-'));
  const fakeGh = join(dir, 'fake-gh.mjs');
  const callsPath = join(dir, 'calls.jsonl');
  try {
    await writeFile(fakeGh, fakeGhSource(), 'utf8');
    await chmod(fakeGh, 0o700);
    const encoded = Buffer.from(JSON.stringify(plan)).toString('base64');
    const { stdout } = await execFileAsync(
      process.execPath,
      [publisherPath, '--plan-base64', encoded],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_TTY_TRIAGE_PUBLISH_GH: fakeGh,
          FAKE_GH_CALLS: callsPath,
          FAKE_GH_DIR: dir,
          FAKE_GH_MARKER: marker,
          FAKE_GH_SNAPSHOT_STDOUT: snapshotStdout,
          FAKE_GH_SCENARIO: scenario,
          FAKE_GH_EDIT_LABELS: plan.labelsToAdd.join(','),
        },
      },
    );
    const callsText = await readFile(callsPath, 'utf8').catch(() => '');
    return {
      result: JSON.parse(stdout) as {
        status: string;
        reason: string;
        commentUrl: string | null;
        labelsAdded: string[];
        labelsRemoved: string[];
      },
      calls: callsText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeGhSource(): string {
  return String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\n');

const dir = process.env.FAKE_GH_DIR;
const marker = process.env.FAKE_GH_MARKER;
const scenario = process.env.FAKE_GH_SCENARIO;
const editLabels = (process.env.FAKE_GH_EDIT_LABELS || '').split(',').filter(Boolean);
const editPath = join(dir, 'edited');
const commentPath = join(dir, 'commented');

if (args[0] === 'api' && args[1] === 'user') {
  console.log('mux-bot');
} else if (args[0] === 'issue' && args[1] === 'view' && args.includes('number,title,url,state,body,author,createdAt,updatedAt,labels,comments')) {
  console.log(process.env.FAKE_GH_SNAPSHOT_STDOUT);
} else if (args[0] === 'issue' && args[1] === 'view') {
  const edited = existsSync(editPath);
  const commented = existsSync(commentPath);
  const alreadyPublished = scenario === 'already-published';
  const botMarker = scenario === 'bot-marker-no-labels';
  const labels = scenario === 'ongoing'
    ? ['needs-triage', 'triage:ongoing']
    : ['needs-triage', ...((edited || alreadyPublished) ? editLabels : [])];
  const comments = scenario === 'spoofed-marker' && !commented
    ? [{ body: marker + '\nforged', url: 'https://example.test/attacker', author: { login: 'attacker' } }]
    : commented || alreadyPublished || botMarker
      ? [{ body: marker + '\nposted', url: 'https://example.test/bot', author: { login: 'mux-bot' } }]
      : [];
  console.log(JSON.stringify({ state: 'open', labels, comments }));
} else if (args[0] === 'issue' && args[1] === 'comment') {
  writeFileSync(commentPath, '1');
  console.log('{}');
} else if (args[0] === 'issue' && args[1] === 'edit') {
  if (scenario === 'edit-fails-after-comment') {
    console.error('edit failed after comment');
    process.exit(1);
  }
  writeFileSync(editPath, '1');
  console.log('{}');
} else {
  console.log('{}');
}
`;
}

describe('github issue triage publisher', () => {
  it('does not trust attacker-authored marker comments', async () => {
    const { result, calls } = await runPublisher(
      triagePlan(),
      'spoofed-marker',
    );

    expect(result).toMatchObject({
      status: 'published',
      commentUrl: 'https://example.test/bot',
      reason: '',
    });
    expect(calls.some((call) => call[0] === 'api' && call[1] === 'user')).toBe(
      true,
    );
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'comment'),
    ).toBe(true);
    expect(
      calls
        .find((call) => call[0] === 'issue' && call[1] === 'view')
        ?.some((arg) => arg.includes('[-100:]') && arg.includes('[0:1024]')),
    ).toBe(true);
  });

  it('treats authenticated existing markers and labels as idempotent success', async () => {
    const { result, calls } = await runPublisher(
      triagePlan(),
      'already-published',
    );

    expect(result).toMatchObject({
      status: 'already_published',
      commentUrl: 'https://example.test/bot',
      reason: '',
    });
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'comment'),
    ).toBe(false);
  });

  it('does not recover partial marker-only publishes without manual review', async () => {
    const { result, calls } = await runPublisher(
      triagePlan({
        preconditions: {
          ...triagePlan().preconditions,
          conversationHash: 'wrong-hash',
        },
      }),
      'bot-marker-no-labels',
    );

    expect(result).toMatchObject({
      status: 'deferred',
      commentUrl: 'https://example.test/bot',
      labelsAdded: [],
      labelsRemoved: [],
      reason: 'partial-publish-requires-manual-recovery',
    });
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'edit'),
    ).toBe(false);
  });

  it('reports partial evidence when label application fails after posting', async () => {
    const { result, calls } = await runPublisher(
      triagePlan(),
      'edit-fails-after-comment',
    );

    expect(result).toMatchObject({
      status: 'deferred',
      commentUrl: 'https://example.test/bot',
      labelsAdded: [],
      labelsRemoved: [],
      reason: 'partial-publish-requires-manual-recovery',
    });
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'comment'),
    ).toBe(true);
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'edit'),
    ).toBe(true);
  });

  it('defers without mutation when the conversation hash changed', async () => {
    const { result, calls } = await runPublisher(
      triagePlan({
        preconditions: {
          ...triagePlan().preconditions,
          conversationHash: 'wrong-hash',
        },
      }),
      'normal',
    );

    expect(result).toMatchObject({
      status: 'deferred',
      reason: 'conversation-changed-after-classification',
    });
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'comment'),
    ).toBe(false);
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'edit'),
    ).toBe(false);
  });

  it('checks current labels before applying risk-stop labels', async () => {
    const { result, calls } = await runPublisher(
      triagePlan({
        kind: 'risk-stop',
        marker: '',
        commentBody: '',
        labelsToAdd: ['triage:stopped', 'risk:high'],
      }),
      'ongoing',
    );

    expect(result).toMatchObject({
      status: 'deferred',
      reason: 'unexpected-label-triage:ongoing',
    });
    expect(calls[0]?.slice(0, 2)).toEqual(['issue', 'view']);
    expect(
      calls.some((call) => call[0] === 'issue' && call[1] === 'edit'),
    ).toBe(false);
  });
});
