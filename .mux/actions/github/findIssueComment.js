const {
  inputObject,
  listComments,
  requiredIssueNumber,
  requiredRepository,
  splitRepository,
  stringList,
} = require('../../workflow-action-lib/github.cjs');

export const metadata = {
  version: 1,
  description: 'Find the latest GitHub issue comment containing expected text',
  effect: 'read',
  inputSchema: mux.schema.object(
    {
      repository: mux.schema.optional(mux.schema.string()),
      owner: mux.schema.optional(mux.schema.string()),
      repo: mux.schema.optional(mux.schema.string()),
      number: mux.schema.integer(),
      requiredBodyIncludes: mux.schema.optional(
        mux.schema.array(mux.schema.string()),
      ),
    },
    { additionalProperties: false },
  ),
  outputSchema: mux.schema.object(
    {
      found: mux.schema.boolean(),
      reason: mux.schema.string(),
      url: mux.schema.nullable(mux.schema.string()),
      commentId: mux.schema.nullable(
        mux.schema.union([mux.schema.integer(), mux.schema.string()]),
      ),
      updatedAt: mux.schema.nullable(mux.schema.string()),
    },
    { additionalProperties: false },
  ),
  permissions: [{ kind: 'command', command: 'gh api' }],
  timeoutMs: 60000,
};

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const parts = splitRepository(repository);
  const number = requiredIssueNumber(input.number);
  const includes = stringList(input.requiredBodyIncludes);
  if (includes.length === 0) {
    throw new Error('requiredBodyIncludes must include at least one string');
  }

  const comments = await listComments(ctx, parts.owner, parts.repo, number);
  const match = comments
    .slice()
    .reverse()
    .find(
      (comment) =>
        typeof comment.body === 'string' &&
        includes.every((text) => comment.body.includes(text)),
    );

  if (!match) {
    return {
      found: false,
      reason: 'not-found',
      url: null,
      commentId: null,
      updatedAt: null,
    };
  }

  return {
    found: true,
    reason: '',
    url: match.html_url || null,
    commentId: match.id || null,
    updatedAt: match.updated_at || null,
  };
}
