#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseUrl = process.env.EMULATE_GITHUB_BASE_URL || 'http://localhost:4011';
const token = process.env.EMULATE_GITHUB_TOKEN || 'test_token_admin';
const args = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function argValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1]) return '';
  return args[index + 1];
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    fail(
      `${options.method || 'GET'} ${path} failed: ${response.status} ${text}`,
    );
  }
  if (!text) return null;
  return JSON.parse(text);
}

function repoParts(repository) {
  const [owner, repo] = String(repository || '').split('/');
  if (!owner || !repo) fail('missing --repo owner/repo');
  return { owner, repo };
}

function normalizeAuthor(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    if (typeof value.login === 'string' && value.login.trim()) return value;
    if (typeof value.name === 'string' && value.name.trim()) return value;
  }
  return { login: process.env.EMULATE_GITHUB_LOGIN || 'admin' };
}

function normalizeIssue(issue, comments = []) {
  return {
    number: issue.number,
    title: issue.title || '',
    url: issue.html_url || issue.url || '',
    state: String(issue.state || '').toLowerCase(),
    body: issue.body || '',
    author: normalizeAuthor(issue.user),
    createdAt: issue.created_at || null,
    updatedAt: issue.updated_at || null,
    labels: (issue.labels || []).map((label) =>
      typeof label === 'string' ? { name: label } : { name: label.name || '' },
    ),
    comments: comments.map((comment) => ({
      author: normalizeAuthor(comment.user || comment.author),
      authorAssociation: comment.author_association || null,
      createdAt: comment.created_at || null,
      updatedAt: comment.updated_at || null,
      url: comment.html_url || comment.url || '',
      body: comment.body || '',
    })),
  };
}

function runJq(value, program) {
  if (!program) {
    process.stdout.write(JSON.stringify(value) + '\n');
    return;
  }
  const proc = spawnSync('jq', ['-c', '-r', program], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
  if (proc.status !== 0) fail(proc.stderr || 'jq failed');
  process.stdout.write(proc.stdout);
}

async function issueView() {
  const issueNumber = args[2];
  const { owner, repo } = repoParts(argValue('--repo'));
  const issue = await request(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  const comments = args.includes('--comments')
    ? await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`)
    : [];
  runJq(normalizeIssue(issue, comments), argValue('--jq'));
}

async function issueComment() {
  const issueNumber = args[2];
  const { owner, repo } = repoParts(argValue('--repo'));
  const bodyFile = argValue('--body-file');
  if (!bodyFile) fail('missing --body-file');
  const body = readFileSync(bodyFile, 'utf8');
  const comment = await request(
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
    },
  );
  process.stdout.write(JSON.stringify(comment) + '\n');
}

async function issueEdit() {
  const issueNumber = args[2];
  const { owner, repo } = repoParts(argValue('--repo'));
  const labelsToAdd = [];
  const labelsToRemove = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--add-label' && args[index + 1])
      labelsToAdd.push(args[index + 1]);
    if (args[index] === '--remove-label' && args[index + 1])
      labelsToRemove.push(args[index + 1]);
  }
  if (labelsToAdd.length > 0) {
    await request(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: labelsToAdd }),
    });
  }
  for (const label of labelsToRemove) {
    await request(
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
    );
  }
  process.stdout.write(
    JSON.stringify({
      labelsAdded: labelsToAdd,
      labelsRemoved: labelsToRemove,
    }) + '\n',
  );
}

async function main() {
  if (args[0] === 'api' && args[1] === 'user') {
    runJq(await request('/user'), argValue('--jq'));
    return;
  }
  if (args[0] === 'issue' && args[1] === 'view') return await issueView();
  if (args[0] === 'issue' && args[1] === 'comment') return await issueComment();
  if (args[0] === 'issue' && args[1] === 'edit') return await issueEdit();
  fail(`unsupported fake gh invocation: ${args.join(' ')}`);
}

await main();
