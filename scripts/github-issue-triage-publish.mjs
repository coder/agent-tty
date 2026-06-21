#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_COMMENT_CHARS = 12000;
const MAX_MARKER_COMMENTS = 100;
const MAX_MARKER_BODY_CHARS = 1024;

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
  validatePreconditions(plan.preconditions);
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
    if (!plan.commentBody.includes(plan.marker)) {
      throw new Error('comment body missing marker');
    }
  }
  if (plan.kind === 'risk-stop') {
    if (plan.commentBody)
      throw new Error('risk-stop plans must not include comment bodies');
    if (plan.marker)
      throw new Error('risk-stop plans must not include markers');
  }
}

function validatePreconditions(preconditions) {
  assertObject(preconditions, 'preconditions');
  if (
    preconditions.state !== null &&
    preconditions.state !== undefined &&
    typeof preconditions.state !== 'string'
  ) {
    throw new Error('preconditions.state must be string or null');
  }
  validateLabelList(
    preconditions.requiredLabels,
    'preconditions.requiredLabels',
  );
  validateLabelList(preconditions.absentLabels, 'preconditions.absentLabels');
  if (
    typeof preconditions.conversationHash !== 'string' ||
    preconditions.conversationHash.trim() === ''
  ) {
    throw new Error('preconditions.conversationHash must be non-empty string');
  }
}

async function publishPlan(plan) {
  const before = await readIssueState(plan);

  if (plan.kind === 'risk-stop') {
    if (plannedLabelsApplied(plan, before.labels)) {
      return successResult(plan, 'labeled', null);
    }
    const retryFailure = await publishPreconditionFailure(plan, before, {
      ignoreAbsentLabels: plan.labelsToAdd,
    });
    if (retryFailure) return deferredResult(plan, retryFailure);
    await applyLabels(plan);
    const after = await readIssueState(plan);
    const labelFailure = labelVerificationFailure(plan, after.labels);
    if (labelFailure) return deferredResult(plan, labelFailure);
    return successResult(plan, 'labeled', null);
  }

  const publisherLogin = await readPublisherLogin();
  const existing = findMarkerComment(
    before.comments,
    plan.marker,
    publisherLogin,
  );
  if (existing) {
    if (!plannedLabelsApplied(plan, before.labels)) {
      return deferredResult(plan, 'partial-publish-requires-manual-recovery');
    }
    return successResult(plan, 'already_published', existing.url || null);
  }

  const preconditionFailure = await publishPreconditionFailure(plan, before);
  if (preconditionFailure) return deferredResult(plan, preconditionFailure);

  await commentIssue(plan);
  await applyLabels(plan);
  const after = await readIssueState(plan);
  const posted = findMarkerComment(after.comments, plan.marker, publisherLogin);
  if (!posted)
    return deferredResult(plan, 'published-comment-marker-not-found');
  const labelFailure = labelVerificationFailure(plan, after.labels);
  if (labelFailure) return deferredResult(plan, labelFailure);
  return successResult(plan, 'published', posted.url || null);
}

function successResult(plan, status, commentUrl) {
  return {
    issue: plan.issue,
    kind: plan.kind,
    status,
    commentUrl,
    labelsAdded: plan.labelsToAdd,
    labelsRemoved: plan.labelsToRemove,
    reason: '',
  };
}

async function publishPreconditionFailure(plan, issueState, options = {}) {
  const preconditions = plan.preconditions;
  const ignoredAbsentLabels = new Set(
    (options.ignoreAbsentLabels || []).map((label) => label.toLowerCase()),
  );
  const expectedState = optionalLower(preconditions.state);
  if (
    expectedState &&
    expectedState !== 'all' &&
    optionalLower(issueState.state) !== expectedState
  ) {
    return 'state-precondition-mismatch';
  }

  const currentLabels = new Set(
    issueState.labels.map((label) => label.toLowerCase()),
  );
  for (const label of preconditions.requiredLabels) {
    if (!currentLabels.has(label.toLowerCase())) {
      return 'missing-required-label-' + label;
    }
  }
  for (const label of preconditions.absentLabels) {
    const key = label.toLowerCase();
    if (!ignoredAbsentLabels.has(key) && currentLabels.has(key)) {
      return 'unexpected-label-' + label;
    }
  }

  if (!options.skipConversationHash) {
    const hash = await readConversationHash(plan);
    if (hash !== preconditions.conversationHash) {
      return 'conversation-changed-after-classification';
    }
  }
  return '';
}

async function readIssueState(plan) {
  const { stdout } = await gh([
    'issue',
    'view',
    String(plan.issue),
    '--repo',
    plan.repository,
    '--comments',
    '--json',
    'comments,labels,state',
    '--jq',
    issueStateJq(),
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return {
    state: optionalLower(parsed.state),
    labels: normalizeLabelNames(parsed.labels),
    comments: normalizeComments(parsed.comments),
  };
}

async function readConversationHash(plan) {
  const { stdout } = await gh(
    [
      'issue',
      'view',
      String(plan.issue),
      '--repo',
      plan.repository,
      '--comments',
      '--json',
      'number,title,url,state,body,author,createdAt,updatedAt,labels,comments',
      '--jq',
      issueHashJq(),
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return createHash('sha256')
    .update(stripOneTrailingNewline(stdout), 'utf8')
    .digest('hex');
}

async function readPublisherLogin() {
  const { stdout } = await gh(['api', 'user', '--jq', '.login']);
  const login = stdout.trim();
  if (!login) throw new Error('publisher login unavailable');
  return login;
}

function issueStateJq() {
  return [
    '{',
    'state,',
    'labels: ((.labels // []) | map(.name // .)),',
    'comments: (((.comments // [])[-' + MAX_MARKER_COMMENTS + ':]) | map({',
    'author, url,',
    'body: ((.body // "") | .[0:' + MAX_MARKER_BODY_CHARS + '])',
    '}))',
    '}',
  ].join(' ');
}

function issueHashJq() {
  return [
    '{',
    'number, title, url, state, author, createdAt, updatedAt, labels,',
    'body: (.body // ""),',
    'comments: ((.comments // []) | map({',
    'author, authorAssociation, createdAt, updatedAt, url,',
    'body: (.body // "")',
    '}))',
    '}',
  ].join(' ');
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

async function gh(args, options = {}) {
  return await execFileAsync(
    process.env.AGENT_TTY_TRIAGE_PUBLISH_GH || 'gh',
    args,
    {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 1024 * 1024,
    },
  );
}

function findMarkerComment(comments, marker, publisherLogin) {
  if (!Array.isArray(comments)) return null;
  const expectedLogin = publisherLogin.toLowerCase();
  return (
    comments.find((comment) => {
      return (
        typeof comment?.body === 'string' &&
        comment.body.includes(marker) &&
        commentAuthorLogin(comment).toLowerCase() === expectedLogin
      );
    }) || null
  );
}

function commentAuthorLogin(comment) {
  const author = comment && comment.author;
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object') {
    return optionalString(author.login) || optionalString(author.name) || '';
  }
  return '';
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.map((comment) => ({
    body: typeof comment?.body === 'string' ? comment.body : '',
    url: typeof comment?.url === 'string' ? comment.url : '',
    author: comment?.author || null,
  }));
}

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (
        label &&
        typeof label === 'object' &&
        typeof label.name === 'string'
      ) {
        return label.name;
      }
      return '';
    })
    .filter(Boolean);
}

function plannedLabelsApplied(plan, labels) {
  return labelVerificationFailure(plan, labels) === '';
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

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalLower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function stripOneTrailingNewline(value) {
  return String(value).replace(/\r?\n$/, '');
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
