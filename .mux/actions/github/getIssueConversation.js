const {
  boundedCharBudget,
  boundedLimit,
  getIssueView,
  inputObject,
  listComments,
  normalizeIssue,
  repositoryFromInput,
  requiredIssueNumber,
  splitRepository,
  truncateText,
} = require('../../workflow-action-lib/github.cjs');

export const metadata = {
  version: 1,
  description: 'Read a GitHub issue body and comments as markdown',
  effect: 'read',
  inputSchema: mux.schema.object(
    {
      repository: mux.schema.optional(mux.schema.string()),
      owner: mux.schema.optional(mux.schema.string()),
      repo: mux.schema.optional(mux.schema.string()),
      number: mux.schema.integer(),
      maxComments: mux.schema.optional(mux.schema.integer()),
      issueBodyCharBudget: mux.schema.optional(mux.schema.integer()),
      bodyCharBudget: mux.schema.optional(mux.schema.integer()),
      commentBodyCharBudget: mux.schema.optional(mux.schema.integer()),
    },
    { additionalProperties: false },
  ),
  outputSchema: mux.schema.object(
    {
      repository: mux.schema.nullable(mux.schema.string()),
      number: mux.schema.integer(),
      issue: mux.schema.object(
        {
          number: mux.schema.integer(),
          safeId: mux.schema.string(),
          title: mux.schema.string(),
          url: mux.schema.string(),
          state: mux.schema.string(),
          body: mux.schema.string(),
          author: mux.schema.nullable(mux.schema.string()),
          createdAt: mux.schema.nullable(mux.schema.string()),
          updatedAt: mux.schema.nullable(mux.schema.string()),
          labelNames: mux.schema.array(mux.schema.string()),
        },
        { additionalProperties: false },
      ),
      conversationMarkdown: mux.schema.string(),
      limits: mux.schema.object(
        {
          maxComments: mux.schema.integer(),
          issueBodyBudget: mux.schema.integer(),
          commentBodyBudget: mux.schema.integer(),
          hasOmittedComments: mux.schema.boolean(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  permissions: [
    { kind: 'command', command: 'gh issue view' },
    { kind: 'command', command: 'gh api' },
  ],
  timeoutMs: 60000,
};

function repositoryPartsForComments(repository, issue) {
  if (repository) return splitRepository(repository);
  const match =
    typeof issue.url === 'string'
      ? issue.url.match(
          /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+$/,
        )
      : null;
  if (!match)
    throw new Error(
      'repository or a GitHub issue URL is required to read comments',
    );
  return { owner: match[1], repo: match[2] };
}

function formatConversation(comments, commentBodyBudget, hasOmittedComments) {
  const visibleComments = Array.isArray(comments) ? comments : [];
  if (visibleComments.length === 0) return '(no issue comments)';
  const markdown = visibleComments
    .map(
      (comment) =>
        '### Comment by ' +
        ((comment.author && comment.author.login) || 'unknown') +
        '\n\n' +
        truncateText(comment.body || '', commentBodyBudget),
    )
    .join('\n\n---\n\n');
  return hasOmittedComments
    ? markdown + '\n\n[omitted additional comments]'
    : markdown;
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = repositoryFromInput(input);
  const number = requiredIssueNumber(input.number);
  const maxComments = boundedLimit(input.maxComments, 100);
  const issueBodyBudget = boundedCharBudget(
    input.issueBodyCharBudget ?? input.bodyCharBudget,
    10000,
  );
  const commentBodyBudget = boundedCharBudget(
    input.commentBodyCharBudget,
    10000,
  );
  const issueFields = [
    'number',
    'title',
    'url',
    'state',
    'body',
    'author',
    'labels',
  ];
  let issue;
  let comments;
  if (repository) {
    const parts = splitRepository(repository);
    [issue, comments] = await Promise.all([
      getIssueView(ctx, repository, number, issueFields),
      listComments(ctx, parts.owner, parts.repo, number, {
        limit: maxComments + 1,
      }),
    ]);
  } else {
    issue = await getIssueView(ctx, repository, number, issueFields);
    const parts = repositoryPartsForComments(repository, issue);
    comments = await listComments(ctx, parts.owner, parts.repo, number, {
      limit: maxComments + 1,
    });
  }
  const visibleComments = comments.slice(0, maxComments);
  const hasOmittedComments = comments.length > visibleComments.length;
  const normalizedIssue = normalizeIssue(issue);
  return {
    repository: repository || null,
    number,
    issue: {
      ...normalizedIssue,
      body: truncateText(normalizedIssue.body, issueBodyBudget),
    },
    conversationMarkdown: formatConversation(
      visibleComments,
      commentBodyBudget,
      hasOmittedComments,
    ),
    limits: {
      maxComments,
      issueBodyBudget,
      commentBodyBudget,
      hasOmittedComments,
    },
  };
}
