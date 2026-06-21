#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_COMMENT_CHARS = 12000;

async function main() {
  let plan;
  try {
    plan = parsePlan(process.argv.slice(2));
    validatePlan(plan);
    const result = await publishPlan(plan);
    writeJson(result);
  } catch (error) {
    writeJson(deferredResult(plan, compactReason(error)));
  }
}

function parsePlan(argv) {
  const base64Index = argv.indexOf('--plan-base64');
  if (base64Index !== -1) {
    const encoded = argv[base64Index + 1];
    if (!encoded) throw new Error('missing --plan-base64 value');
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  }
  throw new Error(
    'usage: github-issue-triage-publish.mjs --plan-base64 <json>',
  );
}

function validatePlan(plan) {
  assertObject(plan, 'plan');
  if (!['triage-comment', 'risk-stop'].includes(plan.kind)) {
    throw new Error('invalid plan kind');
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(plan.repository || '')) {
    throw new Error('invalid repository');
  }
  if (!Number.isInteger(plan.issue) || plan.issue <= 0) {
    throw new Error('invalid issue');
  }
  validateLabelList(plan.labelsToAdd, 'labelsToAdd');
  validateLabelList(plan.labelsToRemove, 'labelsToRemove');
  validateLabelList(plan.allowedLabels, 'allowedLabels');
  assertAllowedLabels(plan.labelsToAdd, plan.allowedLabels, 'labelsToAdd');
  assertAllowedLabels(
    plan.labelsToRemove,
    plan.allowedLabels,
    'labelsToRemove',
  );
  if (plan.kind === 'triage-comment') {
    if (
      typeof plan.commentBody !== 'string' ||
      plan.commentBody.trim() === ''
    ) {
      throw new Error('missing comment body');
    }
    if (plan.commentBody.length > MAX_COMMENT_CHARS) {
      throw new Error('comment body too long');
    }
    if (typeof plan.marker !== 'string' || plan.marker.trim() === '') {
      throw new Error('missing marker');
    }
  }
  if (plan.kind === 'risk-stop' && plan.commentBody) {
    throw new Error('risk-stop plans must not include comment bodies');
  }
}

async function publishPlan(plan) {
  if (plan.kind === 'risk-stop') {
    await applyLabels(plan);
    const after = await viewIssue(plan);
    const labelFailure = labelVerificationFailure(plan, after.labels);
    if (labelFailure) return deferredResult(plan, labelFailure);
    return {
      issue: plan.issue,
      kind: plan.kind,
      status: 'labeled',
      commentUrl: null,
      labelsAdded: plan.labelsToAdd,
      labelsRemoved: plan.labelsToRemove,
      reason: '',
    };
  }

  const before = await viewIssue(plan);
  const existing = findMarkerComment(before.comments, plan.marker);
  if (existing) {
    await applyLabels(plan);
    const after = await viewIssue(plan);
    const labelFailure = labelVerificationFailure(plan, after.labels);
    if (labelFailure) return deferredResult(plan, labelFailure);
    return {
      issue: plan.issue,
      kind: plan.kind,
      status: 'already_published',
      commentUrl: existing.url || null,
      labelsAdded: plan.labelsToAdd,
      labelsRemoved: plan.labelsToRemove,
      reason: '',
    };
  }

  await commentIssue(plan);
  await applyLabels(plan);
  const after = await viewIssue(plan);
  const posted = findMarkerComment(after.comments, plan.marker);
  if (!posted)
    return deferredResult(plan, 'published-comment-marker-not-found');
  const labelFailure = labelVerificationFailure(plan, after.labels);
  if (labelFailure) return deferredResult(plan, labelFailure);
  return {
    issue: plan.issue,
    kind: plan.kind,
    status: 'published',
    commentUrl: posted && posted.url ? posted.url : null,
    labelsAdded: plan.labelsToAdd,
    labelsRemoved: plan.labelsToRemove,
    reason: '',
  };
}

async function viewIssue(plan) {
  const { stdout } = await gh([
    'issue',
    'view',
    String(plan.issue),
    '--repo',
    plan.repository,
    '--comments',
    '--json',
    'comments,labels',
    '--jq',
    '{comments: ((.comments // []) | map({body, url})), labels: ((.labels // []) | map(.name))}',
  ]);
  return JSON.parse(stdout || '{}');
}

async function commentIssue(plan) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-tty-triage-'));
  const bodyFile = join(dir, 'comment.md');
  try {
    await writeFile(bodyFile, plan.commentBody, 'utf8');
    await gh([
      'issue',
      'comment',
      String(plan.issue),
      '--repo',
      plan.repository,
      '--body-file',
      bodyFile,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function applyLabels(plan) {
  const argv = ['issue', 'edit', String(plan.issue), '--repo', plan.repository];
  for (const label of plan.labelsToAdd) argv.push('--add-label', label);
  for (const label of plan.labelsToRemove) argv.push('--remove-label', label);
  if (argv.length > 5) await gh(argv);
}

async function gh(args) {
  return await execFileAsync(
    process.env.AGENT_TTY_TRIAGE_PUBLISH_GH || 'gh',
    args,
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

function findMarkerComment(comments, marker) {
  if (!Array.isArray(comments)) return null;
  return (
    comments.find(
      (comment) =>
        typeof comment?.body === 'string' && comment.body.includes(marker),
    ) || null
  );
}

function labelVerificationFailure(plan, labels) {
  const actual = new Set(
    Array.isArray(labels)
      ? labels
          .filter((label) => typeof label === 'string')
          .map((label) => label.toLowerCase())
      : [],
  );
  for (const label of plan.labelsToAdd) {
    if (!actual.has(label.toLowerCase())) return 'missing-label-' + label;
  }
  for (const label of plan.labelsToRemove) {
    if (actual.has(label.toLowerCase())) return 'label-still-present-' + label;
  }
  return '';
}

function validateLabelList(value, name) {
  if (!Array.isArray(value)) throw new Error(name + ' must be an array');
  for (const label of value) validateLabel(label);
}

function validateLabel(label) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('label values must be non-empty strings');
  }
  if (label.length > 100 || /[\0\r\n]/.test(label)) {
    throw new Error('label values must be single-line strings under 100 chars');
  }
}

function assertAllowedLabels(labels, allowedLabels, name) {
  const allowed = new Set(allowedLabels.map((label) => label.toLowerCase()));
  for (const label of labels) {
    if (!allowed.has(label.toLowerCase()))
      throw new Error(name + ' not allowed');
  }
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(name + ' must be an object');
  }
}

function deferredResult(plan, reason) {
  const kind =
    plan && ['triage-comment', 'risk-stop'].includes(plan.kind)
      ? plan.kind
      : 'triage-comment';
  return {
    issue: plan && Number.isInteger(plan.issue) ? plan.issue : 0,
    kind,
    status: 'deferred',
    commentUrl: null,
    labelsAdded: [],
    labelsRemoved: [],
    reason,
  };
}

function compactReason(error) {
  return String(error?.message || error || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

await main();
