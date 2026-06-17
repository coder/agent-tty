const s = mux.schema;
const PUBLISHED_REPORT_NOTE = 'This triage report is AI-generated using Mux';

export const metadata = {
  description:
    'Reconcile GitHub issues without triage:done into persistent triage workspaces',
  argsSchema: s.object({
    repository: s.optional(s.string()),
    owner: s.optional(s.string()),
    repo: s.optional(s.string()),
    doneLabel: s.optional(s.string({ default: 'triage:done' })),
    ongoingLabel: s.optional(s.string({ default: 'triage:ongoing' })),
    excludeLabels: s.optional(s.array(s.string(), { default: [] })),
    includeLabels: s.optional(s.array(s.string(), { default: [] })),
    projectPath: s.optional(s.string()),
    state: s.optional(s.string({ default: 'open' })),
    marker: s.optional(s.string({ default: 'mux-github-issue-triage' })),
    promptVersion: s.optional(s.string({ default: 'v1' })),
    trunkBranch: s.optional(s.string({ default: 'main' })),
    agentId: s.optional(s.string({ default: 'exec' })),
    model: s.optional(s.string()),
    limit: s.optional(s.integer({ default: 1000, minimum: 1, maximum: 1000 })),
    awaitTimeoutMs: s.optional(
      s.integer({ default: 1000, minimum: 0, maximum: 600000 }),
    ),
    preSendIdleTimeoutMs: s.optional(
      s.integer({ default: 5000, minimum: 0, maximum: 600000 }),
    ),
    publishAttemptCount: s.optional(
      s.integer({ default: 3, minimum: 1, maximum: 5 }),
    ),
    maxParallelActions: s.optional(
      s.integer({ default: 8, minimum: 1, maximum: 32 }),
    ),
  }),
};

function buildPublishPrompt(issue, attempt, lastReason) {
  return `Please post a concise public triage comment to the GitHub issue.

Start the GitHub comment with exactly this note:

\`\`\`markdown
> [!NOTE]
> ${PUBLISHED_REPORT_NOTE}
\`\`\`

Write for maintainers and issue participants. Summarize the triage outcome;
do not describe how the triage was performed.

Editorial requirements:
- Do not mention internal workflow mechanics.
- Do not include workflow names, workflow run IDs, agent IDs, model names, or phrases like "the workflow concluded", "deep-research workflow", or "I ran deep-research".
- Treat research results as supporting analysis only. Fold them into normal sections such as Findings, Recommendation, or Suggested next steps.
- Do not include a standalone "Deep-research" section.
- Do not include process/provenance sections unless the detail is directly needed to reproduce or evaluate the issue.
- Do not ping people.
- Prefer passive or neutral wording over third-person references to issue participants.

Use this structure unless the issue clearly needs a smaller one:

\`\`\`markdown
> [!NOTE]
> ${PUBLISHED_REPORT_NOTE}

## Summary

1-3 bullets describing what was triaged and the outcome.

## Findings

Actionable repo facts, reproduction observations, or prior-art findings.
Keep this focused on what maintainers need to know.

## Recommendation

State the recommended disposition or implementation direction.
If there are tradeoffs, include only the important ones.

## Suggested next steps

Concrete follow-up items, such as tests, docs, or code paths to update.
\`\`\`

For bug reports, include reproduction details only if they help a maintainer verify the issue. Prefer a short command snippet plus observed result. Avoid long logs.

For feature requests or design decisions, focus on:
- whether the request fits the repo,
- what existing behavior or architecture supports the recommendation,
- what gap remains,
- and what the smallest useful next step is.

If files, logs, screenshots, or generated artifacts are included, first ensure they contain no secrets or sensitive information. Only include them when they materially help review the issue. Put long supporting material in a <details> block.

Before posting, self-edit the comment:
- Remove duplicated headings.
- Remove any "how the triage was done" prose.
- Merge research/provenance sections into Findings or Recommendation.
- Keep the comment concise and maintainer-actionable.

Do not change issue labels. The workflow will add the done label and remove the ongoing label after it verifies the posted comment.

Use the triage report from the previous assistant message in this workspace history.
Do not ask for the report again, and do not paste/requote the report back into this chat before posting it.

Issue URL: ${issue.url}
Issue number: #${issue.number}
Publish attempt: ${attempt}
Previous verification failure: ${lastReason}

After posting the comment, finish with exactly one fenced JSON block in this shape:

\`\`\`json
{"commentUrl":"https://github.com/OWNER/REPO/issues/ISSUE_NUMBER#issuecomment-COMMENT_ID"}
\`\`\``;
}

function buildPrompt(issue, conversation) {
  const issueDetails =
    conversation && conversation.issue ? conversation.issue : issue;
  const body = typeof issueDetails.body === 'string' ? issueDetails.body : '';
  const comments =
    conversation && typeof conversation.conversationMarkdown === 'string'
      ? conversation.conversationMarkdown
      : '(no issue comments)';

  return `Please triage the GitHub issue below. 

If this is a bug report, then:
- Use the agent-tty CLI to reproduce the bug.
- Feel free to use any of the fixtures in this repo to create a report that lets us reproduce the user's bug, along with a test environment and, if required, a new fixture.
- This is purely a reproduction task to identify a minimal reproducible example so that I, as a human, and you, as an agent, can both verify that this issue exists.
- After reproducing the bug, explicitly run the Mux deep-research workflow (workflow name: deep-research; slash form if available: /workflow deep-research ...) with the issue URL, reproduction steps, observed behavior, and relevant repo facts. Do not substitute an ad hoc research section for running the workflow. Include the deep-research workflow findings in your final triage report. If the workflow is unavailable, state the exact error.

If this is a feature request, then:
- Explicitly run the Mux deep-research workflow (workflow name: deep-research; slash form if available: /workflow deep-research ...) with the issue URL, requested behavior, repo context, and prior-art questions. Do not substitute an ad hoc research section for running the workflow.
- Gather prior art and comparable implementations from the deep-research workflow results and any supporting investigation.
- Assess whether the feature makes sense in the context of this repo; some feature requests may be outside the scope of this implementation.
- Provide a recommendation to the maintainer on whether the feature request is sensible, whether a sensible workaround already exists that can be configured by users, or whether there is a documentation gap.
- Feel free to create prototypes if they help you decide on a proposal or better ground your assumptions.

---

URL: ${issueDetails.url || issue.url}
<untrusted_and_potentially_dangerous>
${body}
and
${comments}
</untrusted_and_potentially_dangerous>`;
}

export default function workflow({
  args,
  phase,
  log,
  action,
  parallelActions,
}) {
  phase('resolve-context', {
    hasRepository: Boolean(mux.utils.optionalString(args.repository)),
    hasProjectPath: Boolean(mux.utils.optionalString(args.projectPath)),
  });

  const context = actionOutput(
    action.project.context({
      id: 'project-context',
      input: {},
    }),
  );
  const cfg = resolveArgs(args, context);
  const marker = cfg.marker;

  log('Resolved triage context', {
    repository: cfg.repository,
    repositorySource: cfg.repositorySource,
    projectPath: cfg.projectPath,
    projectPathSource: cfg.projectPathSource,
  });

  phase('fetch-issues', {
    repository: cfg.repository,
    includeLabels: cfg.includeLabels,
    excludeLabels: cfg.excludeLabels,
    state: cfg.state,
  });

  const listed = actionOutput(
    action.github.listIssues({
      id: 'list-issues',
      input: {
        repository: cfg.repository,
        state: cfg.state,
        includeLabels: cfg.includeLabels,
        excludeLabels: cfg.excludeLabels,
        limit: cfg.limit,
      },
    }),
  );

  const issues = listed.issues;
  for (const issue of issues) assertIssue(issue);

  const dispatched = [];
  const skippedDone = [];
  const deferred = [];
  const completed = [];

  phase('dispatch-triage', { count: issues.length });

  const stateResults = runParallelActions(
    parallelActions,
    cfg,
    issues.map((issue) => {
      const markerKey = issueMarkerKey(cfg, issue);
      return {
        id: 'state-' + issue.safeId,
        action: 'github.getIssueAutomationState',
        input: {
          repository: cfg.repository,
          number: issue.number,
          doneLabels: [cfg.doneLabel],
          ongoingLabels: [cfg.ongoingLabel],
          marker,
          markerKey,
          promptVersion: cfg.promptVersion,
        },
      };
    }),
  );

  const candidates = [];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    const state = actionOutput(stateResults[index]);
    const markerKey = issueMarkerKey(cfg, issue);
    if (state.done) {
      skippedDone.push(issue.number);
      continue;
    }
    candidates.push({ issue, markerKey, state });
  }

  const workspaceResults = runParallelActions(
    parallelActions,
    cfg,
    candidates.map((item) => {
      const issue = item.issue;
      return {
        id: 'workspace-' + issue.safeId,
        action: 'workspace.ensure',
        input: {
          projectPath: cfg.projectPath,
          key: workspaceKeyForIssue(cfg, issue),
          title: `Triage #${issue.number}: ${issue.title}`,
          trunkBranch: cfg.trunkBranch,
          branchName: 'triage/issue-' + issue.number,
        },
      };
    }),
  );

  const active = candidates.map((item, index) => ({
    ...item,
    workspaceId: actionOutput(workspaceResults[index]).workspaceId,
  }));

  const needsPrompt = active.filter((item) => !item.state.promptStarted);
  const preSendIdleResults = runParallelActions(
    parallelActions,
    cfg,
    needsPrompt.map((item) => ({
      id: 'pre-send-idle-' + item.issue.safeId,
      action: 'workspace.awaitIdle',
      input: {
        workspaceId: item.workspaceId,
        timeoutMs: cfg.preSendIdleTimeoutMs,
      },
    })),
  );

  const needingConversation = needsPrompt.filter(
    (item, index) => actionOutput(preSendIdleResults[index]).idle,
  );
  const conversationResults = runParallelActions(
    parallelActions,
    cfg,
    needingConversation.map((item) => ({
      id: 'conversation-' + item.issue.safeId,
      action: 'github.getIssueConversation',
      input: {
        repository: cfg.repository,
        number: item.issue.number,
      },
    })),
  );

  runParallelActions(
    parallelActions,
    cfg,
    needingConversation.map((item) => ({
      id: 'mark-triage-ongoing-' + item.issue.safeId + '-' + cfg.promptVersion,
      action: 'github.ensureIssueLabels',
      input: {
        repository: cfg.repository,
        number: item.issue.number,
        addLabels: [cfg.ongoingLabel],
      },
    })),
  );

  runParallelActions(
    parallelActions,
    cfg,
    needingConversation.map((item, index) => ({
      id: 'send-triage-prompt-' + item.issue.safeId + '-' + cfg.promptVersion,
      action: 'workspace.sendMessage',
      input: {
        workspaceId: item.workspaceId,
        agentId: cfg.agentId,
        model: cfg.model,
        message: buildPrompt(
          item.issue,
          actionOutput(conversationResults[index]),
        ),
      },
    })),
  );

  for (const item of needingConversation) dispatched.push(item.issue.number);

  phase('collect-finished-triage', {
    active: active.length,
    awaitTimeoutMs: cfg.awaitTimeoutMs,
  });

  const idleResults = runParallelActions(
    parallelActions,
    cfg,
    active.map((item) => ({
      id: 'await-idle-' + item.issue.safeId,
      action: 'workspace.awaitIdle',
      input: {
        workspaceId: item.workspaceId,
        timeoutMs: cfg.awaitTimeoutMs,
      },
    })),
  );

  const reportCandidates = [];
  for (let index = 0; index < active.length; index += 1) {
    const item = active[index];
    if (!actionOutput(idleResults[index]).idle) {
      deferred.push({
        issue: item.issue.number,
        reason: 'workspace-still-running',
      });
      continue;
    }
    reportCandidates.push(item);
  }

  const reportResults = runParallelActions(
    parallelActions,
    cfg,
    reportCandidates.map((item) => ({
      id: 'latest-report-' + item.issue.safeId,
      action: 'workspace.getLatestAssistantMessage',
      input: { workspaceId: item.workspaceId },
    })),
  );

  for (let index = 0; index < reportCandidates.length; index += 1) {
    const item = reportCandidates[index];
    const issue = item.issue;
    const latest = actionOutput(reportResults[index]);

    if (!hasAssistantText(latest)) {
      deferred.push({ issue: issue.number, reason: 'no-assistant-report' });
      continue;
    }

    const publishResult = publishReportWithWorkspaceLoop(
      action,
      cfg,
      item,
      latest.text,
    );
    if (!publishResult.completed) {
      deferred.push({ issue: issue.number, reason: publishResult.reason });
      continue;
    }

    completed.push({
      issue: issue.number,
      commentUrl: publishResult.commentUrl,
    });
  }

  log('Triage reconcile complete', {
    completed,
    dispatched,
    deferred,
    skippedDone,
  });

  return {
    reportMarkdown: summaryMarkdown(
      completed,
      dispatched,
      deferred,
      skippedDone,
    ),
    structuredOutput: { completed, dispatched, deferred, skippedDone },
  };
}

function runParallelActions(parallelActions, cfg, specs) {
  if (specs.length === 0) return [];
  if (typeof parallelActions !== 'function') {
    throw new Error('parallelActions is required for concurrent issue triage');
  }
  return parallelActions(specs, { maxParallel: cfg.maxParallelActions });
}

function actionOutput(result) {
  if (!result || typeof result !== 'object' || !('output' in result)) {
    throw new Error('Workflow action returned an unexpected result envelope');
  }
  return result.output;
}

function resolveArgs(args, context) {
  const repository =
    mux.utils.optionalString(args.repository) ||
    repositoryFromOwnerRepo(args.owner, args.repo) ||
    mux.utils.optionalString(context.repository);
  const projectPath =
    mux.utils.optionalString(args.projectPath) ||
    mux.utils.optionalString(context.projectPath);
  const excludeLabels =
    args.excludeLabels.length > 0 ? args.excludeLabels : [args.doneLabel];

  if (args.doneLabel === args.ongoingLabel) {
    throw new Error('doneLabel and ongoingLabel must be different labels');
  }

  if (!repository) {
    throw new Error(
      'repository or owner/repo is required for stable issue keys',
    );
  }

  if (!projectPath) {
    throw new Error(
      'projectPath is required so workspace.ensure can create/reuse issue workspaces',
    );
  }

  return {
    ...args,
    repository,
    repositorySource: mux.utils.optionalString(args.repository)
      ? 'args.repository'
      : repositoryFromOwnerRepo(args.owner, args.repo)
        ? 'args.owner/repo'
        : context.repositorySource,
    projectPath,
    projectPathSource: mux.utils.optionalString(args.projectPath)
      ? 'args.projectPath'
      : context.projectPathSource,
    excludeLabels,
  };
}

function repositoryFromOwnerRepo(owner, repo) {
  const ownerName = mux.utils.optionalString(owner);
  const repoName = mux.utils.optionalString(repo);
  return ownerName && repoName ? ownerName + '/' + repoName : undefined;
}

function assertIssue(issue) {
  if (!issue || !Number.isInteger(issue.number) || issue.number <= 0) {
    throw new Error(
      'github.listIssues returned an issue without a positive integer number',
    );
  }
  if (typeof issue.safeId !== 'string' || issue.safeId.length === 0) {
    throw new Error(
      'github.listIssues returned issue #' + issue.number + ' without safeId',
    );
  }
}

function workspaceKeyForIssue(cfg, issue) {
  return 'github-triage:' + cfg.repository + '#' + issue.number;
}

function issueMarkerKey(cfg, issue) {
  return cfg.repository + '#' + issue.number;
}

function hasAssistantText(result) {
  return (
    result &&
    result.found === true &&
    typeof result.text === 'string' &&
    result.text.trim().length > 0
  );
}

function publishReportWithWorkspaceLoop(action, cfg, item, triageReport) {
  const issue = item.issue;
  let latestText = triageReport;
  let lastReason = 'missing-structured-output';

  const alreadyPosted = extractPublishResult(latestText);
  if (alreadyPosted) {
    const verified = verifyPublishedReport(
      action,
      cfg,
      item,
      alreadyPosted.commentUrl,
      'initial',
    );
    if (verified.completed) return verified;
    lastReason = verified.reason;
  }

  for (let attempt = 1; attempt <= cfg.publishAttemptCount; attempt += 1) {
    action.workspace.sendMessage({
      id:
        'send-publish-prompt-' +
        issue.safeId +
        '-' +
        cfg.promptVersion +
        '-' +
        attempt,
      input: {
        workspaceId: item.workspaceId,
        agentId: cfg.agentId,
        model: cfg.model,
        message: buildPublishPrompt(issue, attempt, lastReason),
      },
    });

    const idle = actionOutput(
      action.workspace.awaitIdle({
        id:
          'await-publish-prompt-' +
          issue.safeId +
          '-' +
          cfg.promptVersion +
          '-' +
          attempt,
        input: {
          workspaceId: item.workspaceId,
          timeoutMs: cfg.awaitTimeoutMs,
        },
      }),
    );

    if (!idle.idle) {
      return { completed: false, reason: 'publish-workspace-still-running' };
    }

    const latest = actionOutput(
      action.workspace.getLatestAssistantMessage({
        id:
          'latest-publish-prompt-' +
          issue.safeId +
          '-' +
          cfg.promptVersion +
          '-' +
          attempt,
        input: { workspaceId: item.workspaceId },
      }),
    );

    if (!hasAssistantText(latest)) {
      lastReason = 'no-publish-output';
      const recovered = findPublishedReport(
        action,
        cfg,
        item,
        'attempt-' + attempt,
      );
      if (recovered.completed) return recovered;
      lastReason = recovered.reason;
      continue;
    }

    latestText = latest.text;
    const published = extractPublishResult(latestText);
    if (!published) {
      lastReason = 'missing-structured-output';
      const recovered = findPublishedReport(
        action,
        cfg,
        item,
        'attempt-' + attempt,
      );
      if (recovered.completed) return recovered;
      lastReason = recovered.reason;
      continue;
    }

    const verified = verifyPublishedReport(
      action,
      cfg,
      item,
      published.commentUrl,
      'attempt-' + attempt,
    );
    if (verified.completed) return verified;
    lastReason = verified.reason;
  }

  return { completed: false, reason: 'publish-not-verified-' + lastReason };
}

function findPublishedReport(action, cfg, item, suffix) {
  const issue = item.issue;
  const found = actionOutput(
    action.github.findIssueComment({
      id: 'find-published-comment-' + issue.safeId + '-' + suffix,
      input: {
        repository: cfg.repository,
        number: issue.number,
        requiredBodyIncludes: [PUBLISHED_REPORT_NOTE],
      },
    }),
  );

  if (!found.found || typeof found.url !== 'string' || found.url.length === 0) {
    return {
      completed: false,
      reason: 'published-comment-not-found-' + (found.reason || 'unknown'),
    };
  }

  return verifyPublishedReport(action, cfg, item, found.url, suffix + '-found');
}

function verifyPublishedReport(action, cfg, item, commentUrl, suffix) {
  const issue = item.issue;
  const comment = actionOutput(
    action.github.verifyIssueCommentUrl({
      id: 'verify-published-comment-' + issue.safeId + '-' + suffix,
      input: {
        repository: cfg.repository,
        number: issue.number,
        url: commentUrl,
        requiredBodyIncludes: [PUBLISHED_REPORT_NOTE],
      },
    }),
  );

  if (!comment.verified) {
    return {
      completed: false,
      reason: 'comment-not-verified-' + (comment.reason || 'unknown'),
    };
  }

  const labels = actionOutput(
    action.github.ensureIssueLabels({
      id: 'complete-triage-labels-' + issue.safeId + '-' + suffix,
      input: {
        repository: cfg.repository,
        number: issue.number,
        addLabels: [cfg.doneLabel],
        removeLabels: [cfg.ongoingLabel],
      },
    }),
  );

  if (!labels.after.includes(cfg.doneLabel)) {
    return { completed: false, reason: 'done-label-missing' };
  }
  if (labels.after.includes(cfg.ongoingLabel)) {
    return { completed: false, reason: 'ongoing-label-still-present' };
  }

  return { completed: true, commentUrl: comment.url || commentUrl };
}

function extractPublishResult(text) {
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text)) !== null) {
    candidates.push(match[1]);
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]);
      if (parsed && typeof parsed.commentUrl === 'string') {
        return { commentUrl: parsed.commentUrl.trim() };
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function summaryMarkdown(completed, dispatched, deferred, skippedDone) {
  return [
    '# GitHub issue triage reconcile',
    '',
    '- Completed: ' + formatCompletedList(completed),
    '- Dispatched: ' + formatIssueList(dispatched),
    '- Deferred: ' + formatDeferredList(deferred),
    '- Already done: ' + formatIssueList(skippedDone),
  ].join('\n');
}

function formatCompletedList(completed) {
  if (completed.length === 0) return '(none)';
  return completed
    .map(function (item) {
      return '#' + item.issue + ' (' + item.commentUrl + ')';
    })
    .join(', ');
}

function formatIssueList(numbers) {
  return numbers.length === 0
    ? '(none)'
    : numbers
        .map(function (number) {
          return '#' + number;
        })
        .join(', ');
}

function formatDeferredList(deferred) {
  if (deferred.length === 0) return '(none)';
  return deferred
    .map(function (item) {
      return '#' + item.issue + ' (' + item.reason + ')';
    })
    .join(', ');
}
