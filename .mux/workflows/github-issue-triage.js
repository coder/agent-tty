const s = mux.schema;

export const metadata = {
  description:
    'Reconcile GitHub issues without triage:done into persistent triage workspaces',
  argsSchema: s.object({
    repository: s.optional(s.string()),
    owner: s.optional(s.string()),
    repo: s.optional(s.string()),
    doneLabel: s.optional(s.string({ default: 'triage:done' })),
    excludeLabels: s.optional(s.array(s.string(), { default: [] })),
    includeLabels: s.optional(s.array(s.string(), { default: [] })),
    projectPath: s.string(),
    state: s.optional(s.string({ default: 'open' })),
    marker: s.optional(s.string({ default: 'mux-github-issue-triage' })),
    promptVersion: s.optional(s.string({ default: 'v1' })),
    trunkBranch: s.optional(s.string({ default: 'main' })),
    agentId: s.optional(s.string({ default: 'exec' })),
    model: s.optional(s.string()),
    limit: s.optional(s.integer({ default: 1000, minimum: 1, maximum: 1000 })),
    awaitTimeoutMs: s.optional(
      s.integer({ default: 1000, minimum: 0, maximum: 21600000 }),
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

function buildPublishPrompt(
  issue,
  triageReport,
  attempt,
  lastReason,
  doneLabel,
) {
  return `Please go ahead and post your triage report to the GitHub issue.
Make sure that you lead with a note that this is an AI generated triage using 
Mux.

\`\`\`markdown
> [!NOTE]  
> This triage report is AI-generated using Mux
\`\`\`

When posting to GitHub, be aware that the issue creator and folks in the
conversation will be pinged.
Writing in a third person might be seen as rude, so consider rephrasing section
into a passive form.
Do not ping people.

Your triage report will be reviewed by the maintainer and is posted publicly,
so that issue creator and the maintainers can have an open discussion.

If you've created files during triage, run an explore agent on each of them to
identify if there are secrets or other sensitive information.
Redact them, or don't post.
If those files pass that screening, feel free to paste their contents into
collapsible boxes, so that one can review the steps you took to reproduce the issue
or how you conducted your investigation.

\`\`\`\`markdown
<details>

<summary>FILE_NAME</summary>

### You can add a header

You can add text within a collapsed section.

You can add an image or a code block, too.

\`\`\`ruby
   puts "Hello World"
\`\`\`

</details>
\`\`\`\`

After you posted the report to GitHub, make sure to attach the \`${doneLabel}\` label to the issue.
If the previous verification failure says the label is missing, do not repost the same report; attach the label and return the existing comment URL.

Use the triage report from this workspace history. The workflow-observed report/output is included below for reference.

Issue URL: ${issue.url}
Issue number: #${issue.number}
Publish attempt: ${attempt}
Previous verification failure: ${lastReason}

Triage report to post:

<triage_report>
${triageReport}
</triage_report>

After posting the comment and attaching the label, finish with exactly one fenced JSON block in this shape:

\`\`\`json
{"commentUrl":"https://github.com/OWNER/REPO/issues/ISSUE_NUMBER#issuecomment-COMMENT_ID","triageDoneLabelAttached":true}
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
- Later on, run a deep research investigation workflow to determine what is causing those issues and how to resolve them.

If this is a feature request, then:
- Perform a deep research workflow into the request.
- Gather prior art and comparable implementations as references.
- Assess whether the feature makes sense in the context of the Claudecode.nvim extension; some feature requests may be outside the scope of this third-party code implementation.
- Provide a recommendation to the maintainer on whether the feature request is sensible, whether a sensible workaround already exists that can be configured in their own config files, or whether there is a documentation gap.
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
  const cfg = resolveArgs(args);
  const marker = cfg.marker;

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

  const idleBeforeSend = needsPrompt.filter(
    (item, index) => actionOutput(preSendIdleResults[index]).idle,
  );
  const latestBeforeSendResults = runParallelActions(
    parallelActions,
    cfg,
    idleBeforeSend.map((item) => ({
      id: 'pre-send-latest-' + item.issue.safeId,
      action: 'workspace.getLatestAssistantMessage',
      input: { workspaceId: item.workspaceId },
    })),
  );

  const needingConversation = idleBeforeSend.filter(
    (item, index) =>
      !hasAssistantText(actionOutput(latestBeforeSendResults[index])),
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
      id: 'mark-prompt-started-' + item.issue.safeId + '-' + cfg.promptVersion,
      action: 'github.upsertIssueComment',
      input: {
        repository: cfg.repository,
        number: item.issue.number,
        marker: markerCommentNeedle(marker, item.markerKey, cfg.promptVersion),
        body: promptStartedComment(
          marker,
          item.markerKey,
          cfg.promptVersion,
          item.workspaceId,
        ),
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

function resolveArgs(args) {
  const repository =
    mux.utils.optionalString(args.repository) ||
    repositoryFromOwnerRepo(args.owner, args.repo);
  const projectPath = mux.utils.optionalString(args.projectPath);
  const excludeLabels =
    args.excludeLabels.length > 0 ? args.excludeLabels : [args.doneLabel];

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

  return { ...args, repository, projectPath, excludeLabels };
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

function markerCommentNeedle(marker, markerKey, promptVersion) {
  return (
    '<!-- ' + marker + ' key=' + markerKey + ' promptVersion=' + promptVersion
  );
}

function promptStartedComment(marker, markerKey, promptVersion, workspaceId) {
  return (
    markerCommentNeedle(marker, markerKey, promptVersion) +
    ' status=prompt-started workspace=' +
    workspaceId +
    ' -->\n\n' +
    'Mux triage has started in workspace `' +
    workspaceId +
    '`.\n\n' +
    'If no triage report appears, remove this marker comment or bump `promptVersion` before rerunning the workflow.'
  );
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
        message: buildPublishPrompt(
          issue,
          triageReport,
          attempt,
          lastReason,
          cfg.doneLabel,
        ),
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
      continue;
    }

    latestText = latest.text;
    const published = extractPublishResult(latestText);
    if (!published) {
      lastReason = 'missing-structured-output';
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

function verifyPublishedReport(action, cfg, item, commentUrl, suffix) {
  const issue = item.issue;
  const comment = actionOutput(
    action.github.verifyIssueCommentUrl({
      id: 'verify-published-comment-' + issue.safeId + '-' + suffix,
      input: {
        repository: cfg.repository,
        number: issue.number,
        url: commentUrl,
        requiredBodyIncludes: ['This triage report is AI-generated using Mux'],
      },
    }),
  );

  if (!comment.verified) {
    return {
      completed: false,
      reason: 'comment-not-verified-' + (comment.reason || 'unknown'),
    };
  }

  const state = actionOutput(
    action.github.getIssueAutomationState({
      id: 'verify-done-label-' + issue.safeId + '-' + suffix,
      input: {
        repository: cfg.repository,
        number: issue.number,
        doneLabels: [cfg.doneLabel],
        marker: cfg.marker,
        markerKey: item.markerKey,
        promptVersion: cfg.promptVersion,
      },
    }),
  );

  if (!state.done) {
    return { completed: false, reason: 'done-label-missing' };
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
